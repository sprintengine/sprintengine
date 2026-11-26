import { randomBytes } from 'crypto'

import type { StudioDatabase } from '../../../server/db/database'
import { createRecordTable, type RecordRow } from '../../../server/db/record-table'
import { installedStudioPlatform } from '../../../server/platform/platform'
import type { SecretCipher } from '../../../server/platform/secret-cipher'
import { normalizeTailnetScopes, type TailnetScope } from '../../../shared/tailnet'
import type { MeshConnection } from '../../../shared/tailnet-mesh'
import { isRecord } from '../../../shared/records'
import { isEnvironmentId } from '../../../../packages/studio-protocol/src/environment'

// The tokens THIS machine holds for OTHER machines.
//
// The mirror image of `tailnet-devices.ts`, and deliberately not the same file:
// that one stores hashes of credentials other machines present to us, which is
// all a verifier needs. This one stores credentials we present elsewhere, so
// the token itself has to come back — but only in this process, just before it
// is sent. On disk each token is sealed with the platform's secret cipher (the
// OS keychain, through Electron's `safeStorage`, in the desktop), the way the
// provider secrets and the sign-in refresh token are.
// A file that any process running as this user can read would otherwise hand
// that process every machine this one is paired with.
//
// When the OS cannot encrypt, this matches those stores too: the token is kept
// in memory for the session and never written, so a pairing made then does not
// survive a restart. A plaintext token never reaches the disk from here.
//
// They are kept in the data folder's database (`mesh_links`, a row each),
// which is the owner's alone (0600). A person can end the remaining risk from either end: forget the
// connection here, or revoke the device on the machine that issued it.
// Revocation lands on our very next request, so the stored token becomes inert
// without us being told.

/** The file builds before the database kept the connections in, under the data folder; read once, by the import. */
export const TAILNET_MESH_FILENAME = 'tailnet-mesh-connections.json'
/** The name that file had before the client side was called the mesh; the import reads it when the other is missing. */
export const LEGACY_TAILNET_MESH_FILENAME = 'tailnet-fleet-connections.json'

/** A stored connection, with the credential the public view omits. */
export type StoredMeshConnection = MeshConnection & { deviceToken: string }

/** In memory: the token for use, and its ciphertext so a rewrite need not ask the keychain again. */
type MeshEntry = StoredMeshConnection & { sealedToken: string | null }

export type TailnetMeshStore = {
  /** Public view: no tokens. This is what IPC returns. */
  list(): MeshConnection[]
  /** Internal view, for the client that must actually authenticate. */
  find(connectionId: string): StoredMeshConnection | null
  add(input: {
    machineName: string
    endpoint: string
    deviceId: string
    deviceName: string
    deviceToken: string
    scopes: TailnetScope[]
    pairedVia: MeshConnection['pairedVia']
  }): MeshConnection
  /** Record what the remote says our grants are now; they can narrow without us being told. */
  updateScopes(connectionId: string, scopes: TailnetScope[]): void
  markConnected(connectionId: string): void
  /**
   * Record the environment id that machine's Studio says it is, from an
   * identity answer. True when that is news (first heard, or the machine now
   * answers as another Studio, reinstalled or replaced); null is ignored, so
   * an older build's silence never erases what a newer one said.
   */
  noteEnvironment(connectionId: string, environmentId: string | null): boolean
  forget(connectionId: string): boolean
  /** Resolves once every change so far is saved (a quit, and the tests). */
  flush(): Promise<void>
}

export function createTailnetMeshStore(options: {
  /** The data folder's database: the connections are kept in its `mesh_links` table. */
  database: StudioDatabase
  /** Production reads the installed platform's cipher; tests inject a stand-in. */
  cipher?: SecretCipher | null
  now?: () => Date
  log?: (message: string) => void
}): TailnetMeshStore {
  const now = options.now ?? (() => new Date())
  const cipher = options.cipher === undefined ? platformCipher() : options.cipher
  const table = createRecordTable(options.database, 'mesh_links', options.log)
  const loaded = readRows(table.loadNow(), cipher, options.log)
  let connections: MeshEntry[] = loaded.connections
  // Sealed records this session could not open (the keychain said no, or is
  // not there yet). They are written back exactly as read: a launch without
  // the keychain must not delete pairings a later launch can still open.
  const unopened = loaded.unopened

  function encryptionAvailable(): boolean {
    try {
      return cipher?.available() === true
    } catch {
      return false
    }
  }

  // Tokens being sealed by a cipher that answers from another process (the
  // shell's keychain, for the Studio server out of process). The record is
  // written without them first, as a session-only pairing would be, and again
  // as soon as each seal lands.
  const sealing = new Set<MeshEntry>()

  function seal(entry: MeshEntry): string | null {
    if (entry.sealedToken) return entry.sealedToken
    if (!cipher || !encryptionAvailable()) return null
    if (cipher.sealAsync) {
      sealLater(entry, cipher.sealAsync.bind(cipher))
      return null
    }
    entry.sealedToken = cipher.seal(entry.deviceToken).toString('base64')
    return entry.sealedToken
  }

  function sealLater(entry: MeshEntry, sealAsync: (plaintext: string) => Promise<Buffer>): void {
    if (sealing.has(entry)) return
    sealing.add(entry)
    void sealAsync(entry.deviceToken).then(
      (sealed) => {
        sealing.delete(entry)
        if (!connections.includes(entry)) return
        entry.sealedToken = sealed.toString('base64')
        safePersist('sealed')
      },
      (error: unknown) => {
        sealing.delete(entry)
        options.log?.(
          `Could not seal the token for ${entry.machineName}, so its pairing lasts until the app quits: ${message(error)}`,
        )
      },
    )
  }

  function persist(): void {
    // A connection whose token cannot be sealed is left out entirely:
    // session-only, the way the other secret stores fall back. A plaintext
    // token never reaches the database.
    const rows: RecordRow[] = connections.flatMap((entry) => {
      const sealedToken = seal(entry)
      return sealedToken ? [{ id: entry.id, body: JSON.stringify({ ...publicConnection(entry), sealedToken }) }] : []
    })
    for (const entry of unopened) rows.push({ id: String(entry.id), body: JSON.stringify(entry) })
    void table.save(rows)
  }

  function safePersist(context: string): void {
    try {
      persist()
    } catch (error) {
      // Diagnostics only. Losing a last-connected timestamp must not fail the
      // browse a person is waiting on.
      options.log?.(`Could not write ${TAILNET_MESH_FILENAME} (${context}): ${message(error)}`)
    }
  }

  return {
    flush: () => table.flush(),
    list: () => connections.map(publicConnection),

    find: (connectionId) => {
      const entry = connections.find((candidate) => candidate.id === connectionId)
      return entry ? { ...publicConnection(entry), deviceToken: entry.deviceToken } : null
    },

    add(input): MeshConnection {
      const stored: MeshEntry = {
        id: `tnc_${randomBytes(9).toString('base64url')}`,
        machineName: input.machineName.slice(0, 120),
        endpoint: input.endpoint,
        deviceId: input.deviceId,
        deviceName: input.deviceName.slice(0, 120),
        scopes: normalizeTailnetScopes(input.scopes),
        pairedAt: now().toISOString(),
        lastConnectedAt: null,
        pairedVia: input.pairedVia,
        deviceToken: input.deviceToken,
        sealedToken: null,
      }
      // Pairing twice with the same machine issues a SECOND device over there,
      // so both records are real and both are listed. Silently replacing the
      // first would leave a device paired on the other machine that nothing
      // here could ever name for revocation.
      const previous = connections
      connections = [...connections, stored]
      try {
        // Unlike last-seen, this write is the whole point of pairing: a token we
        // cannot persist is a pairing that will not survive a restart, so the
        // failure must reach the caller.
        persist()
        if (!stored.sealedToken && !sealing.has(stored)) {
          options.log?.(
            `This system cannot encrypt secrets, so the pairing with ${stored.machineName} lasts until the app quits.`,
          )
        }
      } catch (error) {
        // And it must not leave a connection listed that the next launch will
        // not have — the caller tells the person to revoke and pair again, and a
        // row still sitting in the list would contradict that advice.
        connections = previous
        throw error
      }
      return publicConnection(stored)
    },

    updateScopes(connectionId, scopes): void {
      const entry = connections.find((candidate) => candidate.id === connectionId)
      if (!entry) return
      const next = normalizeTailnetScopes(scopes)
      if (sameScopes(entry.scopes, next)) return
      entry.scopes = next
      safePersist('scopes')
    },

    markConnected(connectionId): void {
      const entry = connections.find((candidate) => candidate.id === connectionId)
      if (!entry) return
      entry.lastConnectedAt = now().toISOString()
      safePersist('last-connected')
    },

    noteEnvironment(connectionId, environmentId): boolean {
      if (!isEnvironmentId(environmentId)) return false
      const entry = connections.find((candidate) => candidate.id === connectionId)
      if (!entry || entry.environmentId === environmentId) return false
      entry.environmentId = environmentId
      safePersist('environment')
      return true
    },

    forget(connectionId): boolean {
      const next = connections.filter((entry) => entry.id !== connectionId)
      if (next.length === connections.length) return false
      connections = next
      persist()
      return true
    },
  }
}

function publicConnection(entry: MeshConnection): MeshConnection {
  return {
    id: entry.id,
    machineName: entry.machineName,
    endpoint: entry.endpoint,
    deviceId: entry.deviceId,
    deviceName: entry.deviceName,
    scopes: [...entry.scopes],
    pairedAt: entry.pairedAt,
    lastConnectedAt: entry.lastConnectedAt,
    pairedVia: entry.pairedVia,
    ...(entry.environmentId ? { environmentId: entry.environmentId } : {}),
  }
}

function sameScopes(left: readonly TailnetScope[], right: readonly TailnetScope[]): boolean {
  return left.length === right.length && left.every((scope, index) => scope === right[index])
}

type ReadResult = { connections: MeshEntry[]; unopened: Record<string, unknown>[] }

/** The connections the rows hold, each token opened; one this session cannot open is kept as it is. */
function readRows(
  rows: readonly RecordRow[],
  cipher: SecretCipher | null,
  log?: (message: string) => void,
): ReadResult {
  const result: ReadResult = { connections: [], unopened: [] }
  for (const row of rows) {
    let entry: unknown
    try {
      entry = JSON.parse(row.body)
    } catch {
      entry = null
    }
    const sealedToken = isRecord(entry) && hasConnectionFields(entry) ? entry.sealedToken : null
    if (!isRecord(entry) || typeof sealedToken !== 'string' || !sealedToken) {
      log?.(`A paired machine's record (${row.id}) does not read; pair that machine again.`)
      continue
    }
    const token = openToken(sealedToken, cipher, log)
    if (token === null) result.unopened.push(entry)
    else result.connections.push(normalize(entry, token, sealedToken))
  }
  return result
}

/**
 * The sealed connections a file builds before the database wrote holds, as
 * written (the import). One with a plaintext token (a file from before tokens
 * were sealed) is left out: it never reaches the database, and that machine
 * is paired again.
 */
export function readTailnetMeshFile(raw: string): { sealed: Record<string, unknown>[]; plaintext: number } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.connections)) return null
  const sealed: Record<string, unknown>[] = []
  let plaintext = 0
  for (const entry of parsed.connections) {
    if (!isRecord(entry) || !hasConnectionFields(entry)) continue
    if (typeof entry.sealedToken === 'string' && entry.sealedToken.length > 0) sealed.push(entry)
    else if (typeof entry.deviceToken === 'string' && entry.deviceToken.length > 0) plaintext += 1
  }
  return { sealed, plaintext }
}

/** The token inside a sealed record, or null when this session cannot open it. */
function openToken(sealed: string, cipher: SecretCipher | null, log?: (message: string) => void): string | null {
  try {
    if (!cipher || !cipher.available()) return null
    const token = cipher.open(Buffer.from(sealed, 'base64'))
    return token.length > 0 ? token : null
  } catch (error) {
    log?.(`Could not open a sealed token in ${TAILNET_MESH_FILENAME}; it is kept for a later launch: ${message(error)}`)
    return null
  }
}

function hasConnectionFields(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.endpoint === 'string' &&
    value.endpoint.length > 0 &&
    typeof value.deviceId === 'string' &&
    typeof value.pairedAt === 'string'
  )
}

function normalize(value: Record<string, unknown>, deviceToken: string, sealedToken: string | null): MeshEntry {
  const endpoint = value.endpoint as string
  return {
    id: value.id as string,
    machineName:
      typeof value.machineName === 'string' && value.machineName ? value.machineName.slice(0, 120) : endpoint,
    endpoint,
    deviceId: value.deviceId as string,
    deviceName: typeof value.deviceName === 'string' ? value.deviceName.slice(0, 120) : '',
    scopes: normalizeTailnetScopes(value.scopes),
    pairedAt: value.pairedAt as string,
    lastConnectedAt: typeof value.lastConnectedAt === 'string' ? value.lastConnectedAt : null,
    // A record from before this was kept says so rather than guessing a path.
    pairedVia: readPairedVia(value.pairedVia),
    ...(isEnvironmentId(value.environmentId) ? { environmentId: value.environmentId } : {}),
    deviceToken,
    sealedToken,
  }
}

/**
 * The installed platform's cipher, or null when no platform is installed (a
 * plain-Node test that injected none). Null reads as "cannot encrypt", which
 * keeps tokens in memory only, as it did outside Electron.
 */
function platformCipher(): SecretCipher | null {
  return installedStudioPlatform()?.secrets ?? null
}

const PAIRED_VIA: ReadonlySet<string> = new Set(['link', 'request', 'reverse', 'unknown'])

function readPairedVia(value: unknown): MeshConnection['pairedVia'] {
  return typeof value === 'string' && PAIRED_VIA.has(value) ? (value as MeshConnection['pairedVia']) : 'unknown'
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
