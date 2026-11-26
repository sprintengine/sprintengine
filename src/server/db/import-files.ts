import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { writeDiagnosticLog } from '../../main/diagnostics-service'
import { LAUNCH_NOTICES_FILE, readSavedLaunchNotices } from '../../main/agent-launch-notices'
import { AGENT_PROMPTS_DIR_NAME, agentPromptKey, parseAgentPromptFile } from '../../main/agent-prompt-store'
import { APPROVAL_RULES_FILENAME } from '../../main/conversation-approval-rules'
import { FIRST_MESSAGES_FILENAME, readFirstMessagesFile } from '../../main/conversation-first-messages'
import { migrateConversationApprovalRule } from '../../shared/conversation/approvalRules'
import { readTailnetDevicesFile, TAILNET_DEVICES_FILENAME } from '../../main/automation/tailnet/tailnet-devices'
import {
  LEGACY_TAILNET_MESH_FILENAME,
  readTailnetMeshFile,
  TAILNET_MESH_FILENAME,
} from '../../main/automation/tailnet/tailnet-mesh-store'
import { EXTENSION_APPROVALS_FILENAME, readExtensionApprovalsFile } from '../../main/modules/extension-approvals'
import { FILE_VIEWS_FILENAME, readFileViewsFile } from '../file-views/file-views'
import { localServerStorePath, readLinkedServersFile } from '../local-servers/local-server-record'
import { CLIENT_TOOLSETS_FILENAME, readClientToolsetsFile } from '../tools/client-toolset-store'
import { EMBEDS_FILENAME, readEmbedsFile } from '../web/embeds'
import { readWebSessionsFile, WEB_SESSIONS_FILENAME } from '../web/web-sessions'
import type { RecordTableName } from './record-table'
import type { DataFormatStep } from '../environment/data-format'
import { prepareStudioDatabase, STUDIO_DATABASE_FILENAME } from './database'
import type { SyncConnection } from './sqlite'

// Bringing in the records builds before the database kept in files, once per
// file, at the format step that moved each store. Each file is read with the
// parser its store used, imported in a transaction of its own and noted in
// `imports`, so a file is never imported twice. A file is never changed, moved
// or deleted: it stays as it was at the upgrade, and an older build that is
// put back (the database moved aside, `format.json` set back) runs on it.
//
// What does not read (a malformed file, a record its store would not keep) is
// skipped and counted, in `imports` and in the diagnostics log. A file that is
// there but cannot be read at all (no permission) stops the step: imported as
// "nothing", its records would be lost to every later start.

/** What one file brought in. */
type FileImport = { source: string; records: number; skipped: number }

type Imported = { records: number; skipped: number }

/**
 * Import `source` (relative to the data folder) unless it was imported
 * before: `read` gets its text, or null when there is no such file, and
 * writes its records through `connection` inside the transaction.
 */
function importFile(
  connection: SyncConnection,
  dataDir: string,
  source: string,
  read: (text: string | null) => Imported,
): FileImport | null {
  if (connection.get('SELECT 1 AS done FROM imports WHERE source = ?', [source])) return null
  let text: string | null
  try {
    text = readFileSync(join(dataDir, source), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    text = null
  }
  return connection.transaction(() => {
    const imported = read(text)
    connection.run('INSERT INTO imports (source, imported_at, records, skipped) VALUES (?, ?, ?, ?)', [
      source,
      Date.now(),
      imported.records,
      imported.skipped,
    ])
    return { source, ...imported }
  })
}

/** Format 2: the database, and the four small chat-side stores moved into it. */
export function importChatSideRecords(connection: SyncConnection, dataDir: string): FileImport[] {
  const done: FileImport[] = []
  const add = (result: FileImport | null) => {
    if (result) done.push(result)
  }

  add(
    importFile(connection, dataDir, FIRST_MESSAGES_FILENAME, (text) => {
      if (text === null) return { records: 0, skipped: 0 }
      const messages = readFirstMessagesFile(text)
      if (!messages) return { records: 0, skipped: 1 }
      let records = 0
      for (const [commandId, message] of Object.entries(messages)) {
        records += connection.run('INSERT OR IGNORE INTO first_messages (command_id, body) VALUES (?, ?)', [
          commandId,
          JSON.stringify(message),
        ]).changes
      }
      return { records, skipped: 0 }
    }),
  )

  add(
    importFile(connection, dataDir, APPROVAL_RULES_FILENAME, (text) => {
      if (text === null) return { records: 0, skipped: 0 }
      let saved: unknown
      try {
        saved = JSON.parse(text)
      } catch {
        return { records: 0, skipped: 1 }
      }
      if (!Array.isArray(saved)) return { records: 0, skipped: 1 }
      let records = 0
      let skipped = 0
      for (const value of saved) {
        // Narrowed as the store narrowed a rule it read; one it would drop is skipped.
        const rule = migrateConversationApprovalRule(value)
        if (!rule) {
          skipped += 1
          continue
        }
        records += connection.run('INSERT OR IGNORE INTO approval_rules (id, workspace_root, body) VALUES (?, ?, ?)', [
          rule.id,
          rule.workspaceRoot,
          JSON.stringify(rule),
        ]).changes
      }
      return { records, skipped }
    }),
  )

  add(
    importFile(connection, dataDir, LAUNCH_NOTICES_FILE, (text) => {
      if (text === null) return { records: 0, skipped: 0 }
      const saved = readSavedLaunchNotices(text)
      if (!saved) return { records: 0, skipped: 1 }
      connection.run('INSERT OR IGNORE INTO launch_notices (id, body) VALUES (1, ?)', [JSON.stringify(saved)])
      return { records: 1, skipped: 0 }
    }),
  )

  let names: string[] = []
  try {
    names = readdirSync(join(dataDir, AGENT_PROMPTS_DIR_NAME)).filter((name) => name.endsWith('.json'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  for (const name of names.sort()) {
    add(
      importFile(connection, dataDir, join(AGENT_PROMPTS_DIR_NAME, name), (text) => {
        if (text === null) return { records: 0, skipped: 0 }
        let file: ReturnType<typeof parseAgentPromptFile> = null
        try {
          file = parseAgentPromptFile(JSON.parse(text))
        } catch {
          file = null
        }
        const key = file ? agentPromptKey(file) : null
        if (!file || !key) return { records: 0, skipped: 1 }
        const { changes } = connection.run(
          'INSERT OR IGNORE INTO agent_prompts (key, workspace_id, agent_id, updated_at, body) VALUES (?, ?, ?, ?, ?)',
          [key, file.workspaceId, file.agentId, file.updatedAt, JSON.stringify(file)],
        )
        return { records: changes, skipped: 0 }
      }),
    )
  }
  return done
}

/** Say what an import skipped, in the diagnostics log; nothing when it skipped nothing. */
function reportSkipped(imports: readonly FileImport[]): void {
  const skipped = imports.filter((entry) => entry.skipped > 0)
  if (skipped.length === 0) return
  void writeDiagnosticLog({
    level: 'warning',
    source: 'workspace',
    title: 'Some records did not import',
    message: `Moving records into the database skipped ${skipped.reduce((sum, entry) => sum + entry.skipped, 0)} that did not read. The files are left as they were.`,
    details: skipped.map((entry) => `${entry.source}: ${entry.skipped} skipped, ${entry.records} kept`).join('\n'),
  }).catch(() => undefined)
}

/** The format step that makes the database: format 1 to 2. */
export const CHAT_SIDE_RECORDS_STEP: DataFormatStep = {
  to: 2,
  files: [],
  database: true,
  run(dataDir) {
    const connection = prepareStudioDatabase(join(dataDir, STUDIO_DATABASE_FILENAME))
    try {
      reportSkipped(importChatSideRecords(connection, dataDir))
    } finally {
      connection.close()
    }
  },
}

/**
 * Import one store's file into its record table (`record-table.ts`): `read`
 * gives the records it keeps, each with its id, or null for a file that is
 * not one; `skipped` counts what it left out.
 */
function importRecordFile(
  connection: SyncConnection,
  dataDir: string,
  source: string,
  table: RecordTableName,
  read: (text: string) => { rows: Array<{ id: string; body: unknown }>; skipped?: number } | null,
): FileImport | null {
  return importFile(connection, dataDir, source, (text) => {
    if (text === null) return { records: 0, skipped: 0 }
    const read_ = read(text)
    if (!read_) return { records: 0, skipped: 1 }
    let records = 0
    for (const [position, row] of read_.rows.entries())
      records += connection.run(`INSERT OR IGNORE INTO ${table} (id, position, body) VALUES (?, ?, ?)`, [
        row.id,
        position,
        JSON.stringify(row.body),
      ]).changes
    return { records, skipped: read_.skipped ?? 0 }
  })
}

/**
 * Format 3: paired devices, the machines this one is paired with, browser
 * sessions, embeds, linked local servers, apps' toolsets, file views and
 * extension approvals. Only what each store would trust is brought in: a
 * device revoked before the upgrade is not in its file and is not here
 * either, and a token kept in plaintext by a file from before tokens were
 * sealed never reaches the database (that machine is paired again).
 */
export function importDeviceAndSessionRecords(connection: SyncConnection, dataDir: string): FileImport[] {
  const mesh = existsSync(join(dataDir, TAILNET_MESH_FILENAME))
    ? TAILNET_MESH_FILENAME
    : existsSync(join(dataDir, LEGACY_TAILNET_MESH_FILENAME))
      ? LEGACY_TAILNET_MESH_FILENAME
      : TAILNET_MESH_FILENAME
  const imports = [
    importRecordFile(connection, dataDir, TAILNET_DEVICES_FILENAME, 'devices', (text) => {
      const devices = readTailnetDevicesFile(text)
      return devices && { rows: devices.map((device) => ({ id: device.id, body: device })) }
    }),
    importRecordFile(connection, dataDir, mesh, 'mesh_links', (text) => {
      const read = readTailnetMeshFile(text)
      return (
        read && { rows: read.sealed.map((entry) => ({ id: String(entry.id), body: entry })), skipped: read.plaintext }
      )
    }),
    importRecordFile(connection, dataDir, WEB_SESSIONS_FILENAME, 'web_sessions', (text) => {
      const sessions = readWebSessionsFile(text)
      return sessions && { rows: sessions.map((session) => ({ id: session.id, body: session })) }
    }),
    importRecordFile(connection, dataDir, EMBEDS_FILENAME, 'embeds', (text) => {
      const embeds = readEmbedsFile(text)
      return embeds && { rows: embeds.map((embed) => ({ id: embed.embedId, body: embed })) }
    }),
    importRecordFile(
      connection,
      dataDir,
      relative(dataDir, localServerStorePath(dataDir)),
      'linked_servers',
      (text) => {
        const servers = readLinkedServersFile(text)
        return servers && { rows: servers.map((server) => ({ id: server.id, body: server })) }
      },
    ),
    importRecordFile(connection, dataDir, CLIENT_TOOLSETS_FILENAME, 'client_toolsets', (text) => {
      const bindings = readClientToolsetsFile(text)
      return bindings && { rows: bindings.map((binding) => ({ id: binding.toolset, body: binding })) }
    }),
    importRecordFile(connection, dataDir, FILE_VIEWS_FILENAME, 'file_views', (text) => {
      const chats = readFileViewsFile(text)
      return chats && { rows: chats.map(({ id, at, paths }) => ({ id, body: { at, paths } })) }
    }),
    importRecordFile(connection, dataDir, EXTENSION_APPROVALS_FILENAME, 'extension_approvals', (text) => {
      const approvals = readExtensionApprovalsFile(text)
      return (
        approvals && { rows: [...approvals].sort(([a], [b]) => a.localeCompare(b)).map(([id, body]) => ({ id, body })) }
      )
    }),
  ]
  return imports.filter((entry): entry is FileImport => entry !== null)
}

/** The format step that moves the device and session records: format 2 to 3. */
export const DEVICE_AND_SESSION_RECORDS_STEP: DataFormatStep = {
  to: 3,
  files: [],
  database: true,
  run(dataDir) {
    const connection = prepareStudioDatabase(join(dataDir, STUDIO_DATABASE_FILENAME))
    try {
      reportSkipped(importDeviceAndSessionRecords(connection, dataDir))
    } finally {
      connection.close()
    }
  },
}
