import {
  KILL_LIST_FUTURE_SKEW_MS,
  findKilled,
  readKillList,
  type KillList,
  type KillListEntry,
} from '../../../../packages/extension-sdk/src/catalogue'
import { readKillListCacheSync, writeKillListCache } from './catalogue-files'

// The kill list: extensions, or versions of them, that turned out harmful.
// Studio reads it periodically, keeps the last copy in its data folder, and
// every standing judged from then on holds a killed version back
// (module-signature.ts), so it is switched off and everything it added is
// retracted at the next `changed()`. A list older than the one kept, or dated
// more than a day ahead, is refused: either would let a later revocation be
// suppressed. A refresh that fails keeps the copy it has and tries again
// sooner, backing off.

/** Revocations must reach a Studio that stays open for days. */
export const KILL_LIST_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000
const RETRY_MS = 15 * 60 * 1000
const RETRY_CAP_MS = 2 * 60 * 60 * 1000

export type KillListService = {
  current(): KillList | null
  find(key: string, version: string): KillListEntry | null
  /** Fetch it now; answers the list kept after. Rejects when the fetch or the list is refused. */
  refresh(): Promise<KillList | null>
  /** Refresh every interval, and sooner after a failure; returns the stopper. */
  startPeriodic(): () => void
}

export function createKillListService(deps: {
  dataDir: string
  fetch: () => Promise<unknown>
  /** The kept list changed: judge every extension again. */
  changed: (previous: KillList | null, next: KillList) => void | Promise<void>
  now?: () => number
  warn?: (message: string) => void
}): KillListService {
  const now = deps.now ?? Date.now
  let chain: Promise<unknown> = Promise.resolve()
  const refresh = (): Promise<KillList | null> => {
    const run = chain.then(async () => {
      const previous = readKillListCacheSync(deps.dataDir)
      const read = readKillList(await deps.fetch())
      if (!read.ok) throw new Error(`The kill list was refused: ${read.message}`)
      const next = read.list
      if (Date.parse(next.generatedAt) > now() + KILL_LIST_FUTURE_SKEW_MS)
        throw new Error('The kill list is dated too far ahead, so it was refused.')
      if (previous && Date.parse(next.generatedAt) < Date.parse(previous.generatedAt))
        throw new Error('The kill list is older than the one Studio has, so it was refused.')
      if (previous && JSON.stringify(previous) === JSON.stringify(next)) return previous
      await writeKillListCache(deps.dataDir, next)
      await deps.changed(previous, next)
      return next
    })
    chain = run.catch(() => undefined)
    return run
  }
  return {
    current: () => readKillListCacheSync(deps.dataDir),
    find: (key, version) => findKilled(readKillListCacheSync(deps.dataDir), key, version),
    refresh,
    startPeriodic() {
      let failures = 0
      let timer: ReturnType<typeof setTimeout> | null = null
      let stopped = false
      const schedule = (delay: number) => {
        if (stopped) return
        timer = setTimeout(() => {
          refresh().then(
            () => {
              failures = 0
              schedule(KILL_LIST_REFRESH_INTERVAL_MS)
            },
            (error: unknown) => {
              failures += 1
              deps.warn?.(`The kill list could not be refreshed; the kept copy holds: ${String(error)}`)
              schedule(Math.min(RETRY_MS * 2 ** (failures - 1), RETRY_CAP_MS))
            },
          )
        }, delay)
        timer.unref?.()
      }
      // Soon after start, then every interval.
      schedule(5_000)
      return () => {
        stopped = true
        if (timer) clearTimeout(timer)
      }
    },
  }
}
