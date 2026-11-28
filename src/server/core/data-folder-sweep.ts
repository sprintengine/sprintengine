import { readdir, rm, stat } from 'node:fs/promises'
import { renameSync } from 'node:fs'
import { join } from 'node:path'

import type { PendingFirstMessages } from '../../main/conversation-first-messages'
import { TERMINAL_SNAPSHOT_SIDECAR_DIR_NAME } from '../../main/terminal-snapshot-sidecar'
import { HANDOVER_EXPORTS_DIRNAME } from '../environment/environment-chat-sources'

// What a server's data folder holds that nothing points at any more, removed
// once per start in the background: picture folders of first messages no row
// names, terminal snapshots a stop left half-written, and the chat histories
// written out for a hand-over before this start. Only inside this data folder:
// the project stores in the home folder are shared with every other data
// folder on the machine, and a chat this one does not know may be another's.

/** A temp file younger than this may be a write in flight: left alone. */
export const STALE_TEMP_MS = 60 * 60_000

/** Where the hand-over's exports from before this start are put aside, to be removed. */
const STALE_EXPORTS_SUFFIX = '.stale'

/**
 * Put the hand-over's exports from the last run aside, at once, before
 * anything this run can export: each send writes its chat's anew, so none of
 * them is read again.
 */
export function setHandoverExportsAside(dataDir: string, now: number = Date.now()): void {
  try {
    renameSync(
      join(dataDir, HANDOVER_EXPORTS_DIRNAME),
      join(dataDir, `${HANDOVER_EXPORTS_DIRNAME}-${now}${STALE_EXPORTS_SUFFIX}`),
    )
  } catch {
    // None there, or not ours to move: the next start tries again.
  }
}

export async function sweepDataFolder(deps: {
  dataDir: string
  firstMessages: Pick<PendingFirstMessages, 'sweep'>
  log: (message: string) => void
  now?: () => number
}): Promise<void> {
  const now = deps.now ?? Date.now
  const removed: string[] = []

  const pictures = await deps.firstMessages.sweep().catch((error: unknown) => {
    deps.log(`First-message pictures could not be swept: ${String(error)}`)
    return 0
  })
  if (pictures > 0) removed.push(`${pictures} first-message picture folder(s)`)

  const snapshots = join(deps.dataDir, TERMINAL_SNAPSHOT_SIDECAR_DIR_NAME)
  let temps = 0
  for (const name of await readdir(snapshots).catch(() => [] as string[])) {
    if (!name.endsWith('.tmp')) continue
    const path = join(snapshots, name)
    const info = await stat(path).catch(() => null)
    if (!info?.isFile() || now() - info.mtimeMs < STALE_TEMP_MS) continue
    await rm(path, { force: true }).then(
      () => (temps += 1),
      () => undefined,
    )
  }
  if (temps > 0) removed.push(`${temps} half-written terminal snapshot(s)`)

  let exports = 0
  for (const name of await readdir(deps.dataDir).catch(() => [] as string[])) {
    if (!name.startsWith(`${HANDOVER_EXPORTS_DIRNAME}-`) || !name.endsWith(STALE_EXPORTS_SUFFIX)) continue
    await rm(join(deps.dataDir, name), { recursive: true, force: true }).then(
      () => (exports += 1),
      () => undefined,
    )
  }
  if (exports > 0) removed.push(`the hand-over's exports from before this start`)

  if (removed.length > 0) deps.log(`Removed what nothing points at any more: ${removed.join(', ')}.`)
}
