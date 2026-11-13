import { studioParams, studioParamsRefused, type StudioMethodTable } from './contract.js'
import {
  STUDIO_DEVICE_TICKETS_CAPABILITY,
  STUDIO_PROVIDER_SIGN_IN_FLOW_CAPABILITY,
  STUDIO_WINDOW_TICKETS_CAPABILITY,
} from './handshake.js'
import type { StudioScope } from './scopes.js'

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
// A paired device (the phone, another desktop's window) reaches the machine
// through the desktop that holds it: the device proves itself to that
// desktop, which asks the machine here for a device ticket with the device's
// own grant, cut to what a relayed device may ever hold
// (`STUDIO_RELAYED_DEVICE_SCOPES`). What that ticket admits is never an
// owner, so never a terminal, and is held to the folders the machine knows.
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

/**
 * The most a device reaching this machine through a desktop may hold: follow,
 * drive and start chats, and read the workspaces they are in. A device ticket
 * asked for anything beyond is refused, whatever the device holds on the
 * desktop that relays it.
 */
export const STUDIO_RELAYED_DEVICE_SCOPES = [
  'conversation:read',
  'conversation:operate',
  'conversation:create',
  'workspaces:read',
] as const satisfies readonly StudioScope[]

export type StudioRelayedDeviceScope = (typeof STUDIO_RELAYED_DEVICE_SCOPES)[number]

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
  /**
   * The window has gone (closed, reloaded, crashed): its unspent tickets are
   * void and its connections end. The desktop's shell alone asks.
   */
  'environment.revokeWindow': { params: { windowKey: string }; result: { revoked: true } }
  /**
   * A ticket for one connection of a paired device the desktop's shell
   * relays here: never an owner's, with exactly the scopes named, each one of
   * `STUDIO_RELAYED_DEVICE_SCOPES`. The desktop's shell alone asks.
   */
  'environment.deviceTicket': {
    params: { deviceId: string; name: string; scopes: StudioRelayedDeviceScope[] }
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
const RELAYS = 'It admits a device the desktop that holds this Studio relays, so only that desktop asks.'
const WINDOW_KEY = '"windowKey" names the window: 1 to 200 characters.'
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
      if (!text(value.windowKey, 200)) return studioParamsRefused(WINDOW_KEY)
      if (!text(value.origin, 200)) return studioParamsRefused('"origin" is the origin the window’s socket says.')
      return studioParams({ windowKey: value.windowKey, origin: value.origin })
    },
  },
  'environment.revokeWindow': {
    scope: null,
    mutation: false,
    capability: STUDIO_WINDOW_TICKETS_CAPABILITY,
    owner: OWN_WINDOW,
    shell: OWN_WINDOW,
    params: (value) =>
      text(value.windowKey, 200) ? studioParams({ windowKey: value.windowKey }) : studioParamsRefused(WINDOW_KEY),
  },
  'environment.deviceTicket': {
    scope: null,
    mutation: false,
    capability: STUDIO_DEVICE_TICKETS_CAPABILITY,
    owner: RELAYS,
    shell: RELAYS,
    params: (value) => {
      if (!(typeof value.deviceId === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value.deviceId)))
        return studioParamsRefused('"deviceId" is the paired device\'s id on the desktop that relays it.')
      if (!text(value.name, 200)) return studioParamsRefused('"name" is the device\'s name: 1 to 200 characters.')
      const scopes = value.scopes
      if (!Array.isArray(scopes) || scopes.length === 0)
        return studioParamsRefused('"scopes" lists what the device may do here: at least one.')
      const allowed: readonly string[] = STUDIO_RELAYED_DEVICE_SCOPES
      for (const scope of scopes)
        if (typeof scope !== 'string' || !allowed.includes(scope))
          return studioParamsRefused(
            `A relayed device holds at most ${STUDIO_RELAYED_DEVICE_SCOPES.join(', ')}; "${String(scope).slice(0, 40)}" is not one.`,
          )
      return studioParams({
        deviceId: value.deviceId,
        name: value.name,
        scopes: STUDIO_RELAYED_DEVICE_SCOPES.filter((scope) => scopes.includes(scope)),
      })
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
