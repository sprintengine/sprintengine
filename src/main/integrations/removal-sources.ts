// Where the removal looks, beyond the ledger: the workspaces the app knows,
// and the homes of the WSL distributions it has written into. Read from the
// profile's own records, because the command line starts none of the app's
// services: the chat records in the data folder's database (format 5 on),
// and the registry file builds before it wrote, which stays beside it.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { parseWorkspaceRegistryFile } from '../../shared/workspace-registry'
import { STUDIO_DATABASE_FILENAME } from '../../server/db/database'
import { SyncConnection } from '../../server/db/sqlite'
import type { ScanHome } from './integration-scan'
import type { IntegrationLedgerEntry } from './ledger'

const WORKSPACE_REGISTRY_FILE = 'workspace-registry.json'

/** The folders of every workspace the profile knows; none from a source that cannot be read. */
export function readRegistryRoots(userDataDir: string): string[] {
  return [...new Set([...rootsInDatabase(userDataDir), ...rootsInFile(userDataDir)])]
}

function rootsInDatabase(userDataDir: string): string[] {
  const path = join(userDataDir, STUDIO_DATABASE_FILENAME)
  if (!existsSync(path)) return []
  let connection: SyncConnection | null = null
  try {
    connection = new SyncConnection(path, { readOnly: true })
    return connection.all<{ body: string }>('SELECT body FROM chats').flatMap((row) => {
      try {
        const folderPath = (JSON.parse(row.body) as { folderPath?: unknown }).folderPath
        return typeof folderPath === 'string' && folderPath ? [folderPath] : []
      } catch {
        return []
      }
    })
  } catch {
    // A database from before the chat records moved, or one that does not open.
    return []
  } finally {
    connection?.close()
  }
}

function rootsInFile(userDataDir: string): string[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(userDataDir, WORKSPACE_REGISTRY_FILE), 'utf8'))
    const parsed = parseWorkspaceRegistryFile(raw)
    if (!parsed) return []
    return parsed.file.workspaces.flatMap((workspace) => (workspace.folderPath ? [workspace.folderPath] : []))
  } catch {
    return []
  }
}

/**
 * Each distribution's home, as this process opens it, from the app-data entry
 * its preparation recorded (`<home>/.local/share/sprintengine-studio`).
 */
export function wslHomesFromLedger(entries: readonly IntegrationLedgerEntry[]): ScanHome[] {
  const homes = new Map<string, ScanHome>()
  for (const entry of entries) {
    if (entry.kind !== 'wsl-data') continue
    const native = dirname(dirname(dirname(entry.path)))
    homes.set(entry.hostId, { native, hostId: entry.hostId })
  }
  return [...homes.values()]
}
