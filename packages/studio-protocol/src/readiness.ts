import { studioParams, type StudioMethodTable } from './contract.js'
import { STUDIO_ENVIRONMENT_READINESS_CAPABILITY } from './handshake.js'

// What a Studio's machine has and lacks for the work it runs on its own.
//
// Schedules and pull request watches run on the server whose store holds
// them, with nobody watching: a schedule starts a chat on a CLI that machine
// must have and be signed in to, with the MCP servers, skills and extension it
// names; a watch reads GitHub through that machine's `gh`. Keys and sign-ins
// are never copied between machines on their own, so a machine may lack one.
// When it does, the work waits, and says why, rather than failing at every
// time or stopping in silence: `waiting` lists each schedule and watch held,
// in words a person can act on ("Codex is not signed in on build-box").
//
// A fact the machine cannot tell for sure is null: a CLI it has not looked
// for yet, a sign-in kept where it cannot read (a keychain). Nothing waits on
// a null; only on a fact it knows is missing.

export type StudioReadinessCli = {
  id: string
  name: string
  /** Whether its command is on this machine; null when it has not been looked for. */
  installed: boolean | null
  /** Whether it holds a sign-in or a key here; null when this machine cannot tell. */
  signedIn: boolean | null
}

export type StudioReadinessWaiting = {
  kind: 'schedule' | 'pull-request-watch'
  /** The schedule's id, or the watched pull request's URL. */
  id: string
  title: string
  /** What the machine lacks, in words: "Codex is not signed in on build-box". */
  reason: string
}

/** What `environment.readiness` answers. */
export type StudioEnvironmentReadiness = {
  /** The machine's name, as the reasons below name it. */
  machine: string
  clis: StudioReadinessCli[]
  gh: { installed: boolean | null; signedIn: boolean | null }
  /** The MCP servers set up here, by id, and whether each is switched on. */
  mcpServers: Array<{ id: string; name: string; enabled: boolean }>
  /** The extensions loaded on this server, by module id; empty where none run. */
  extensions: string[]
  /** The schedules and watches held here, and why. */
  waiting: StudioReadinessWaiting[]
}

export type StudioReadinessMethodMap = {
  /**
   * What this machine has and lacks for its background work, and what waits
   * on it. Read again rather than followed: a sign-in made in a terminal is
   * seen at the next read.
   */
  'environment.readiness': { params: Record<string, never>; result: StudioEnvironmentReadiness }
}

export const STUDIO_READINESS_METHODS: StudioMethodTable<StudioReadinessMethodMap> = {
  // What can run here is what the providers list says, one step further.
  'environment.readiness': {
    scope: 'providers:read',
    mutation: false,
    capability: STUDIO_ENVIRONMENT_READINESS_CAPABILITY,
    params: () => studioParams({}),
  },
}
