import { studioParams, studioParamsRefused, type StudioMethodTable } from './contract.js'
import { STUDIO_PROVIDER_SIGN_IN_FLOW_CAPABILITY, STUDIO_WINDOW_TICKETS_CAPABILITY } from './handshake.js'

// What the desktop that holds a machine's Studio asks of it for the people
// using that desktop: a ticket for one of its windows to connect, and a CLI's
// sign-in on that machine with no terminal.
//
// A WSL distribution's or an SSH machine's Studio is reached by the desktop's
// windows directly (design-wsl-ssh-direct): each window's socket goes to a
// loopback route the desktop's shell keeps, which carries it to the machine's
// own window listener. That listener admits a socket only with a ticket it
// minted itself, so the shell asks for one here, over its own connection,
// for each connection of each window. Only that connection may ask: a ticket
// admits a window of Studio's own, which is shown what an owner is shown.
//
// Signing a chat's CLI in on the machine (decision R34) runs the CLI's own
// login there as a plain child and reads its link, its one-time code and
// whether it waits for a code pasted back. The client shows them, opens the
// link in its own browser, sends the pasted code back, and waits for the end.

/** A ticket for one connection of a window to this Studio's window listener. */
export type StudioWindowTicketGrant = {
  /** The credential the socket's hello presents: good once, for thirty seconds, from the origin it was asked for. */
  token: string
  /** Where on the window listener the socket goes, with the ticket in its query: `/ws?ticket=…`. */
  path: string
}

/** A sign-in that started: its link, the code to type there, and whether a code is pasted back. */
export type StudioSignInStarted =
  { ok: true; id: string; url: string; code: string | null; paste: boolean } | { ok: false; message: string }

/** How a sign-in ended. */
export type StudioSignInDone = { ok: true } | { ok: false; message: string }

export type StudioEnvironmentAccessMethodMap = {
  /**
   * A ticket for one connection of one of the shell's windows. Only the
   * desktop's own shell connection may ask (the method is the shell's, not
   * merely an owner's): an owner's web tab and a paired app are refused.
   */
  'environment.windowTicket': {
    params: { windowKey: string; origin: string }
    result: StudioWindowTicketGrant
  }
  /** Start the CLI's own login on this machine, for a provider whose CLI has one that needs no terminal. */
  'providers.signInStart': { params: { commandId: string; providerId: string }; result: StudioSignInStarted }
  /** Send the code the browser showed back to a sign-in that asked for one. */
  'providers.signInPaste': { params: { commandId: string; id: string; code: string }; result: { ok: boolean } }
  /** Answered when the sign-in ends, however long the person takes (the login's own limit is fifteen minutes). */
  'providers.signInWait': { params: { commandId: string; id: string }; result: StudioSignInDone }
  /** Stop a sign-in. */
  'providers.signInCancel': { params: { commandId: string; id: string }; result: { ok: boolean } }
}

const COMMAND_ID = '"commandId" names this request: 1 to 200 characters.'
const SIGN_IN_ID = '"id" is the sign-in this answers, as its start named it.'

const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max
const commandId = (value: Record<string, unknown>) => text(value.commandId, 200)
const signInId = (value: Record<string, unknown>) => text(value.id, 200)

const OWN_WINDOW =
  'It admits a window of Studio’s own, shown what an owner is shown, so only the desktop that holds this Studio asks.'
const SIGNS_IN = 'It runs a CLI’s login on this machine and keeps its credential here.'

const signIn = {
  scope: 'settings:write',
  mutation: true,
  capability: STUDIO_PROVIDER_SIGN_IN_FLOW_CAPABILITY,
  owner: SIGNS_IN,
} as const

export const STUDIO_ENVIRONMENT_ACCESS_METHODS: StudioMethodTable<StudioEnvironmentAccessMethodMap> = {
  'environment.windowTicket': {
    scope: null,
    mutation: false,
    capability: STUDIO_WINDOW_TICKETS_CAPABILITY,
    owner: OWN_WINDOW,
    shell: OWN_WINDOW,
    params: (value) => {
      if (!text(value.windowKey, 200)) return studioParamsRefused('"windowKey" names the window: 1 to 200 characters.')
      if (!text(value.origin, 200)) return studioParamsRefused('"origin" is the origin the window’s socket says.')
      return studioParams({ windowKey: value.windowKey, origin: value.origin })
    },
  },
  'providers.signInStart': {
    ...signIn,
    params: (value) => {
      if (!commandId(value)) return studioParamsRefused(COMMAND_ID)
      if (!text(value.providerId, 100)) return studioParamsRefused('"providerId" names the provider to sign in.')
      return studioParams({ commandId: value.commandId as string, providerId: value.providerId })
    },
  },
  'providers.signInPaste': {
    ...signIn,
    params: (value) => {
      if (!commandId(value)) return studioParamsRefused(COMMAND_ID)
      if (!signInId(value)) return studioParamsRefused(SIGN_IN_ID)
      if (!text(value.code, 4_096)) return studioParamsRefused('"code" is the code the browser showed.')
      return studioParams({ commandId: value.commandId as string, id: value.id as string, code: value.code })
    },
  },
  'providers.signInWait': {
    ...signIn,
    params: (value) => {
      if (!commandId(value)) return studioParamsRefused(COMMAND_ID)
      if (!signInId(value)) return studioParamsRefused(SIGN_IN_ID)
      return studioParams({ commandId: value.commandId as string, id: value.id as string })
    },
  },
  'providers.signInCancel': {
    ...signIn,
    params: (value) => {
      if (!commandId(value)) return studioParamsRefused(COMMAND_ID)
      if (!signInId(value)) return studioParamsRefused(SIGN_IN_ID)
      return studioParams({ commandId: value.commandId as string, id: value.id as string })
    },
  },
}
