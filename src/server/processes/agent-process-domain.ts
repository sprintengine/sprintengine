import type { StudioProcessesMethodMap, StudioProcessStopOutcome } from '../../../packages/studio-protocol/src/public'
import { parseStudioProcessId } from '../../../packages/studio-protocol/src/public'
import { createProcessReader, type ProcessReader } from './agent-process-reader'
import {
  analyzeProcesses,
  isStudioAppCommand,
  wireProcess,
  type ProcessAnalysis,
  type ProcessSnapshot,
} from './agent-process-scan'

// The programs this machine's agents started, as a server domain: read on
// each ask (agent-process-scan.ts says what is a row) and stopped on an
// owner's word (`processes.*`, an owner's by declaration).
//
// STOPPING IS CHECKED AGAINST A FRESH READ, never against the list a client
// saw. A row names a process by its pid and the second it started; the pid is
// signalled only when, read again now, it is still running, started at that
// second, still carries an agent's identity, and is a program (not Studio,
// not an agent's CLI). A pid that was reused, a process that lost its
// identity, or one that became an agent's is refused, and nothing it started
// is touched either.
//
// What it started goes with it. Where it leads its own process group and the
// group holds nothing Studio or an agent runs, the group is signalled: that
// reaches what it started and then disowned. Otherwise each process under it
// is, minus anything Studio or an agent runs. SIGTERM first; whatever of it
// is still there `STOP_GRACE_MS` later, read again and still the same
// process, gets SIGKILL.

/** How long a stopped program has to end after SIGTERM before it is killed. */
export const STOP_GRACE_MS = 3_000
/** How often a stop looks again while it waits. */
const STOP_POLL_MS = 250
/** How long after SIGKILL a stop looks once more before it says what happened. */
const KILL_SETTLE_MS = 500
/** Asks this close together share one read of the machine. */
const LIST_REUSE_MS = 1_500

export type StudioProcesses = {
  list(): Promise<StudioProcessesMethodMap['processes.list']['result']>
  stop(ids: readonly string[]): Promise<StudioProcessesMethodMap['processes.stop']['result']>
}

export type AgentProcessDomainOptions = {
  /** Null where the machine cannot be read (Windows). */
  reader?: ProcessReader | null
  selfPid?: number
  isStudioCommand?: (command: string) => boolean
  /**
   * Whether a chat is still open here (false: settled, removed, or its
   * workspace gone; null: not known). Only what a closed chat started reads
   * as left behind.
   */
  chatOpen?: (workspaceId: string, agentId: string | undefined) => boolean | null
  /** `process.kill`, for tests. */
  kill?: (pid: number, signal: NodeJS.Signals) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  log?: (message: string, error?: unknown) => void
}

/**
 * Inside the Electron app, every process of its own bundle is Studio's; a
 * plain Node server is a `node` like any other, and only its own line is.
 */
export function studioCommandMatcher(
  execPath: string = process.execPath,
  electron: boolean = Boolean(process.versions.electron),
): (command: string) => boolean {
  const bundle = electron ? (/^(.*?\.app\/)/u.exec(execPath)?.[1] ?? null) : null
  return (command) => isStudioAppCommand(command) || (bundle !== null && command.startsWith(bundle))
}

type Target = { id: string; pid: number; startedAt: number; group: number | null; pids: number[] }

export function createAgentProcessDomain(options: AgentProcessDomainOptions = {}): StudioProcesses {
  const reader = options.reader === undefined ? createProcessReader() : options.reader
  const selfPid = options.selfPid ?? process.pid
  const isStudioCommand = options.isStudioCommand ?? studioCommandMatcher()
  const kill = options.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal))
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now

  const analyze = (snapshot: ProcessSnapshot): ProcessAnalysis =>
    analyzeProcesses(snapshot, {
      selfPid,
      isStudioCommand,
      now: snapshot.scannedAt,
      ...(options.chatOpen ? { chatOpen: options.chatOpen } : {}),
    })

  let recent: { at: number; answer: Promise<StudioProcessesMethodMap['processes.list']['result']> } | null = null

  const scan = async (): Promise<StudioProcessesMethodMap['processes.list']['result']> => {
    if (!reader) return { processes: [], scannedAt: now(), unavailable: 'platform' }
    let snapshot: ProcessSnapshot
    try {
      snapshot = await reader.read()
    } catch (error) {
      options.log?.('Reading this machine’s processes failed.', error)
      return { processes: [], scannedAt: now(), unavailable: 'failed' }
    }
    const { rows } = analyze(snapshot)
    const cwds = await reader.cwds(rows.map((row) => row.pid)).catch(() => new Map<number, string>())
    return { processes: rows.map((row) => wireProcess(row, cwds.get(row.pid))), scannedAt: snapshot.scannedAt }
  }

  /** Whether the process this target named is still running as itself. */
  const stillThere = (snapshot: ProcessSnapshot, pid: number, startedAt: number): boolean => {
    const found = snapshot.processes.find((entry) => entry.pid === pid)
    return found !== undefined && !found.defunct && found.startedAt === startedAt
  }

  const signal = (target: Target, which: NodeJS.Signals, pids: readonly number[]): boolean => {
    let reached = false
    if (target.group !== null) {
      try {
        kill(-target.group, which)
        return true
      } catch {
        // The group is gone, or was never this one's: each process, then.
      }
    }
    for (const pid of pids) {
      try {
        kill(pid, which)
        reached = true
      } catch {
        // Already gone, or not ours to signal.
      }
    }
    return reached
  }

  return {
    list() {
      const at = now()
      if (recent && at - recent.at < LIST_REUSE_MS) return recent.answer
      const answer = scan()
      recent = { at, answer }
      return answer
    },

    async stop(ids) {
      if (!reader) return { results: ids.map((id) => ({ id, outcome: 'refused' as const })), unavailable: 'platform' }
      recent = null
      let snapshot: ProcessSnapshot
      try {
        snapshot = await reader.read()
      } catch (error) {
        options.log?.('Reading this machine’s processes before a stop failed.', error)
        return { results: ids.map((id) => ({ id, outcome: 'failed' as const })), unavailable: 'failed' }
      }
      const analysis = analyze(snapshot)
      const outcomes = new Map<string, StudioProcessStopOutcome>()
      const targets: Target[] = []
      for (const id of ids) {
        const named = parseStudioProcessId(id)
        const found = named ? analysis.byPid.get(named.pid) : undefined
        if (!named || !found || found.defunct) {
          outcomes.set(id, 'gone')
          continue
        }
        if (Math.floor(found.startedAt / 1000) !== named.startSecond) {
          outcomes.set(id, 'changed')
          continue
        }
        if (!found.identity || analysis.roles.get(found.pid) !== 'program') {
          outcomes.set(id, 'refused')
          continue
        }
        const { pids, protectedInside } = analysis.members(found.pid)
        // Its own group, holding nothing that is Studio's or an agent's.
        const groupMembers = snapshot.processes.filter((entry) => entry.pgid === found.pid)
        const groupIsSafe =
          found.pgid === found.pid &&
          !protectedInside &&
          groupMembers.every((entry) => analysis.roles.get(entry.pid) === 'program')
        targets.push({ id, pid: found.pid, startedAt: found.startedAt, group: groupIsSafe ? found.pid : null, pids })
      }

      for (const target of targets) {
        if (!signal(target, 'SIGTERM', target.pids)) outcomes.set(target.id, 'failed')
      }

      // Wait for them to go, reading the machine again.
      let pending = targets.filter((target) => !outcomes.has(target.id))
      const deadline = now() + STOP_GRACE_MS
      // Nothing is killed on the strength of the read from before SIGTERM: a
      // pid it names may have ended and been handed to another program since.
      let fresh = false
      while (pending.length > 0 && now() < deadline) {
        await sleep(STOP_POLL_MS)
        const again = await reader.read().catch(() => null)
        if (!again) continue
        snapshot = again
        fresh = true
        pending = pending.filter((target) => stillThere(snapshot, target.pid, target.startedAt))
      }
      if (!fresh) {
        const again = await reader.read().catch(() => null)
        if (!again) {
          options.log?.('Reading this machine’s processes after a stop failed; nothing was killed.')
          for (const target of targets) if (!outcomes.has(target.id)) outcomes.set(target.id, 'failed')
          return { results: ids.map((id) => ({ id, outcome: outcomes.get(id) ?? 'gone' })) }
        }
        snapshot = again
      }

      // Whatever is left, and still the same process, is killed.
      const survivors = (target: Target) =>
        target.pids.filter((pid) => {
          const before = analysis.byPid.get(pid)
          return before !== undefined && stillThere(snapshot, pid, before.startedAt)
        })
      let killed = false
      for (const target of targets) {
        if (outcomes.has(target.id)) continue
        const left = survivors(target)
        if (left.length === 0) continue
        const leaderLeft = left.includes(target.pid)
        signal({ ...target, group: leaderLeft ? target.group : null }, 'SIGKILL', left)
        killed = true
      }
      if (killed) {
        await sleep(KILL_SETTLE_MS)
        snapshot = (await reader.read().catch(() => null)) ?? snapshot
      }
      for (const target of targets) {
        if (outcomes.has(target.id)) continue
        outcomes.set(target.id, stillThere(snapshot, target.pid, target.startedAt) ? 'failed' : 'stopped')
      }
      return { results: ids.map((id) => ({ id, outcome: outcomes.get(id) ?? 'gone' })) }
    },
  }
}
