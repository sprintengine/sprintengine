import type { ClientId } from './client'

// What each client is held to, and what it cannot do yet.
//
// Every row of the matrix runs. A row that fails and is listed here is a known
// gap: the gate says so and passes. A row that fails and is not listed fails
// the gate. A listed row that passes fails it too ("remove it from the
// list"), so this list only ever shrinks: the cut-over that closes a gap
// deletes its line in the same change.

export const SCENARIOS = [
  'create',
  'stream',
  'upload',
  'approval',
  'subagent',
  'schedule',
  'resume',
  'restart',
  'isolation',
] as const
export type ScenarioId = (typeof SCENARIOS)[number]

export const SCENARIO_WORDS: Record<ScenarioId, string> = {
  create: 'start a chat on the fake provider; the others follow it',
  stream: 'send a turn; every client sees it streamed and waiting on its approval',
  upload: 'send a message with a picture; every client sees it',
  approval: "answer the approval another client's turn raised; every client sees the turn end",
  subagent: 'message a running sub-agent; every client sees the words',
  schedule: 'schedule a send; the clients that list them see it, and it survives a restart',
  resume: 'drop mid-turn, miss events, come back by cursor: no gap, no duplicate, no reset',
  restart:
    'the server is killed and started again; the client comes back by itself and by its cursor (no gap, no duplicate, no reset) and goes on',
  isolation: 'held to its one chat, reading: every other ask is refused',
}

/** Which rows each client is held to. A read-only embed is not asked to write. */
export const ROWS: Record<ClientId, readonly ScenarioId[]> = {
  desktop: ['create', 'stream', 'upload', 'approval', 'subagent', 'schedule', 'resume', 'restart'],
  peer: ['create', 'stream', 'upload', 'approval', 'subagent', 'schedule', 'resume', 'restart'],
  phone: ['create', 'stream', 'upload', 'approval', 'subagent', 'schedule', 'resume', 'restart'],
  embed: ['stream', 'resume', 'restart', 'isolation'],
  ssh: ['create', 'stream', 'upload', 'approval', 'subagent', 'schedule', 'resume', 'restart'],
}

/** `expect`: what the row's failure says today; failing for any other reason is a failure. */
export type KnownGap = { reason: string; closedBy: string; expect: RegExp }

export const KNOWN_GAPS: Partial<Record<`${ClientId}:${ScenarioId}`, KnownGap>> = {
  'peer:create': {
    reason:
      'another device starts a chat by naming a CLI (conversation.create), and the fake provider has none; the request is sent and must be refused as it is today',
    closedBy: 'a contract that starts a chat by provider as well as by CLI, or a fake CLI runtime in the gate',
    expect: /cannot run as a chat/u,
  },
  'phone:create': {
    reason:
      'the phone starts a chat by naming a CLI (conversation.create on the Studio protocol, /tailnet/v1/studio), and the fake provider has none; the request is sent and must be refused as it is today',
    closedBy: 'a contract that starts a chat by provider as well as by CLI, or a fake CLI runtime in the gate',
    expect: /cannot run as a chat/u,
  },
  'ssh:schedule': {
    reason:
      "a scheduled send into an SSH machine's chat is kept by the desktop's scheduler, which this leg does not run",
    closedBy:
      'the change that makes SSH machines environments a client connects to, with their schedules kept on the machine',
    expect: /has no call to/u,
  },
}

/** What the gate cannot run on a hosted runner, and how a person checks it by hand. */
export const NOT_RUN = [
  {
    what: 'WSL',
    why: 'WSL 2 does not run on the hosted Windows runners (no nested virtualization)',
    manual:
      'On a Windows PC with a WSL 2 distribution: build the app (npm run dist:win), turn on WSL chats, start a chat in the distribution, send a turn, answer its approval from the phone and from a paired desktop, then quit and reopen the app and send again.',
  },
] as const
