import {
  studioNoParams,
  studioParams,
  studioParamsRefused,
  type StudioMethodTable,
  type StudioParamsRefusal,
} from './contract.js'
import { STUDIO_BROWSER_TABS_CAPABILITY, STUDIO_PROCESSES_CAPABILITY } from './handshake.js'

// The programs a Studio's agents started on its machine and that are still
// running: a dev server an agent ran in the background, a headless browser a
// script opened, anything a tool call left going. Every process an agent
// starts inherits the agent's identity in its environment
// (`SPRINTENGINE_WORKSPACE_ID`, `SPRINTENGINE_AGENT_ID` and the chat's session
// id), and keeps it when its parent dies and it is handed to the system. So
// the Studio reads its own user's processes where its agents run, keeps the
// ones carrying that identity, and lists one row per program: the process at
// the top of what the agent started, with what it started in turn folded into
// the row.
//
// Nothing here is a record: the list is what is running now, read on each
// ask. A client asks when it opens the list and again every few seconds while
// it is on screen; there is no change stream.
//
// A row is `left-behind` when nothing of its agent is running any more (the
// chat's CLI ended, crashed or was closed) and the program was handed to the
// system: nobody will stop it. `on-its-own` is the same hand-over while the
// agent that started it is still running (a server it put in the background
// on purpose, say), and `with-agent` is a program still under its agent.
//
// An owner's by declaration, behind the `processes` capability, as local
// servers are: `stop` ends programs on this machine, and the list shows the
// commands they were started with. No other grant reaches either, a paired
// device's included. `stop` names rows by their id, which is the process id
// and the second it started: the Studio reads its processes again, and
// signals one only when that process is still running, started at that same
// second, still carries an agent's identity, and is neither Studio itself nor
// an agent's CLI. Signalled with SIGTERM, then SIGKILL for whatever of it is
// still there a few seconds later.

/** Whether the agent that started a program can still stop it. */
export type StudioProcessState = 'left-behind' | 'on-its-own' | 'with-agent'

/** What kind of program a row is, for its glyph and its words. */
export type StudioProcessKind = 'browser' | 'server' | 'program'

/** One program an agent started, with what it started folded in. */
export type StudioAgentProcess = {
  /** `<pid>-<start second>`: what `stop` names, never the same for two processes. */
  id: string
  pid: number
  /** When it started, ms epoch (to the second). */
  startedAt: number
  /** Its name in words: `Headless Chrome`, `Vite dev server`, `python http.server`, else its program's name. */
  name: string
  kind: StudioProcessKind
  /** The command line it was started with, at most `STUDIO_PROCESS_MAX_COMMAND` characters. */
  command: string
  /** The folder it runs in, when the Studio could read it. */
  cwd?: string
  /** The TCP ports it and what it started listen on, ascending. */
  ports: number[]
  /** The memory it and what it started hold, in bytes. */
  memoryBytes: number
  /** How many processes it started that are folded into this row. */
  childCount: number
  state: StudioProcessState
  /** Whether a process of the agent that started it is running on this machine. */
  agentRunning: boolean
  /** The workspace whose agent started it. */
  workspaceId: string
  /** The agent that started it, when its environment says. */
  agentId?: string
  /** The chat session it was started in, when its environment says. */
  sessionId?: string
}

/**
 * Why there is no list: `platform` on a system the Studio cannot read yet
 * (Windows), `failed` when reading this machine's processes went wrong.
 */
export type StudioProcessesUnavailable = 'platform' | 'failed'

/** What `stop` did with one row. */
export type StudioProcessStopOutcome =
  /** It was signalled and is gone. */
  | 'stopped'
  /** It was no longer running. */
  | 'gone'
  /** Its process id belongs to another program now: it started at another time. */
  | 'changed'
  /** It no longer carries an agent's identity, or is Studio or an agent's CLI: the Studio does not stop it. */
  | 'refused'
  /** It was signalled and is still running, or the system refused the signal. */
  | 'failed'

/** The most rows one `stop` may name. */
export const STUDIO_PROCESSES_MAX_STOP = 200
/** The longest command line a row carries; a longer one is cut at its end. */
export const STUDIO_PROCESS_MAX_COMMAND = 4096

export type StudioProcessesMethodMap = {
  /**
   * Every program this machine's agents started that is still running, the
   * longest-running first. `unavailable` says why there is no list, and
   * `processes` is empty then.
   */
  'processes.list': {
    params: Record<string, never>
    result: {
      processes: StudioAgentProcess[]
      /** When the machine was read, ms epoch. */
      scannedAt: number
      unavailable?: StudioProcessesUnavailable
    }
  }
  /**
   * Stop these rows, each with what it started. Answered once every one is
   * stopped or given up on, each with its outcome, in the order asked.
   */
  'processes.stop': {
    params: { ids: string[]; commandId: string }
    result: {
      results: Array<{ id: string; outcome: StudioProcessStopOutcome }>
      unavailable?: StudioProcessesUnavailable
    }
  }
}

export type StudioProcessesMethod = keyof StudioProcessesMethodMap

// ── Browser tabs ────────────────────────────────────────────────────────────
//
// The pages open in a desktop's built-in browser, across every chat and
// window: what an agent or the person opened and nobody is looking at, a
// game's music among them. Listed with whether each is making sound now, and
// closed from any client the way the pane's own close button closes it.
// Behind `browser-tabs`, which only a desktop with the browser pane offers.
// Reached by scope: a paired device that may read a workspace sees its tabs,
// and one that may operate it closes them. Nothing here reaches into a page.

/** One page open in the built-in browser. */
export type StudioBrowserTab = {
  tabId: string
  /** The chat whose pane holds it. */
  workspaceId: string
  title: string
  url: string
  /** When it was opened in this run of the app, ms epoch. */
  openedAt: number
  /** When the person or an agent last navigated or acted on it, ms epoch. */
  lastUsedAt: number
  /** It is playing sound right now. */
  audible: boolean
  /** The agents driving it, if any. */
  agentIds: string[]
  /** It is the tab the person has in front of them. */
  inView: boolean
  /** When it will be closed for going unused, ms epoch; absent when it will not be. */
  closesAt?: number
}

/** The longest title or URL a listed tab carries. */
export const STUDIO_BROWSER_TAB_MAX_TEXT = 2048

export type StudioBrowserTabsMethodMap = {
  /** Every tab open in the built-in browser, the longest-open first. */
  'browserTabs.list': { params: Record<string, never>; result: { tabs: StudioBrowserTab[] } }
  /**
   * Close a tab as its pane's close button does. `closed` is false when there
   * was no such tab, or no window took the close.
   */
  'browserTabs.close': { params: { tabId: string; commandId: string }; result: { closed: boolean } }
}

// ── Validation ──────────────────────────────────────────────────────────────

const refuse = (message: string): StudioParamsRefusal => studioParamsRefused(message)

const ROW_ID = /^[1-9]\d{0,9}-\d{1,12}$/u

/** A row's id, `<pid>-<start second>`, read back into its parts; null when it is not one. */
export function parseStudioProcessId(value: unknown): { pid: number; startSecond: number } | null {
  if (typeof value !== 'string' || !ROW_ID.test(value)) return null
  const [pid, start] = value.split('-')
  const parsed = { pid: Number(pid), startSecond: Number(start) }
  return Number.isSafeInteger(parsed.pid) && Number.isSafeInteger(parsed.startSecond) ? parsed : null
}

/** The id a row is named by. */
export function studioProcessId(pid: number, startedAt: number): string {
  return `${pid}-${Math.floor(startedAt / 1000)}`
}

// Stopping a program here, and the command lines of what an agent ran.
const PROCESSES_OWNER = "Only an owner's connection reads the programs agents started on this machine, or stops one."

export const STUDIO_BROWSER_TABS_METHODS: StudioMethodTable<StudioBrowserTabsMethodMap> = {
  'browserTabs.list': {
    scope: 'workspaces:read',
    mutation: false,
    capability: STUDIO_BROWSER_TABS_CAPABILITY,
    params: studioNoParams,
  },
  'browserTabs.close': {
    scope: 'workspaces:operate',
    mutation: true,
    capability: STUDIO_BROWSER_TABS_CAPABILITY,
    params: (value) => {
      if (typeof value.commandId !== 'string' || value.commandId.length === 0 || value.commandId.length > 200)
        return refuse('"commandId" must be a string of 1 to 200 characters.')
      if (typeof value.tabId !== 'string' || value.tabId.length === 0 || value.tabId.length > 200)
        return refuse('"tabId" is a tab\'s id, from browserTabs.list.')
      return studioParams({ tabId: value.tabId, commandId: value.commandId })
    },
  },
}

export const STUDIO_PROCESSES_METHODS: StudioMethodTable<StudioProcessesMethodMap> = {
  'processes.list': {
    scope: 'workspaces:read',
    mutation: false,
    capability: STUDIO_PROCESSES_CAPABILITY,
    owner: PROCESSES_OWNER,
    params: studioNoParams,
  },
  // Ending a program is driving an agent's work, not reading it.
  'processes.stop': {
    scope: 'conversation:operate',
    mutation: true,
    capability: STUDIO_PROCESSES_CAPABILITY,
    owner: PROCESSES_OWNER,
    params: (value) => {
      if (typeof value.commandId !== 'string' || value.commandId.length === 0 || value.commandId.length > 200)
        return refuse('"commandId" must be a string of 1 to 200 characters.')
      if (!Array.isArray(value.ids) || value.ids.length === 0 || value.ids.length > STUDIO_PROCESSES_MAX_STOP)
        return refuse(`"ids" is a list of 1 to ${STUDIO_PROCESSES_MAX_STOP} row ids, from processes.list.`)
      if (!value.ids.every((id) => parseStudioProcessId(id) !== null))
        return refuse('Every entry of "ids" is a row id, from processes.list.')
      return studioParams({ ids: [...new Set(value.ids as string[])], commandId: value.commandId })
    },
  },
}
