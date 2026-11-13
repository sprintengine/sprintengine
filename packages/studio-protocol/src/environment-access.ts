import { studioParams, studioParamsRefused, type StudioMethodTable } from './contract.js'
import {
  STUDIO_ENVIRONMENT_ADOPT_CAPABILITY,
  STUDIO_DEVICE_TICKETS_CAPABILITY,
  STUDIO_ENVIRONMENT_WORK_CAPABILITY,
  STUDIO_PROVIDER_SIGN_IN_FLOW_CAPABILITY,
  STUDIO_RELAYED_ENVIRONMENTS_CAPABILITY,
  STUDIO_WINDOW_TICKETS_CAPABILITY,
} from './handshake.js'
import type { StudioScope } from './scopes.js'
import { isEnvironmentId } from './environment.js'

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

/**
 * A machine this desktop relays its paired devices to: an SSH machine or a
 * WSL distribution whose Studio this desktop holds. A device reaches it at
 * `/tailnet/v1/environments/<environmentId>/studio` here, with a ticket from
 * `ws-ticket` naming the environment, and is held there to its own grant cut
 * to `STUDIO_RELAYED_DEVICE_SCOPES`. Only machines whose environment id this
 * desktop has heard are listed.
 */
export type StudioRelayedEnvironment = {
  environmentId: string
  /** What the person called the machine here. */
  name: string
  kind: 'ssh' | 'wsl'
  /** Whether this desktop holds a connection to its Studio now. */
  connected: boolean
  /**
   * Its host and port, as its marks are keyed: answered to the owner only. A
   * device needs the name, the mark and the route, never the address.
   */
  machine?: { host: string; port?: number | null }
  /** Its kind and colour, as this desktop marks it (the person's choice applied); absent when it cannot be named. */
  mark?: { kind: string; color: string }
}

const RELAYED_NAME_MAX = 200

/**
 * A desktop's `environment.relayed` answer as a client may use it: each
 * entry whose environment id is one (so its route and its socket path can be
 * spelled), with a name, and its mark only when whole. Anything else is
 * dropped, not refused: one bad entry from a paired desktop does not hide
 * the rest. `machine` is never read back: a client has no use for it.
 */
export function relayedEnvironmentsOf(value: unknown): Array<Omit<StudioRelayedEnvironment, 'machine'>> {
  const list = value && typeof value === 'object' ? (value as { environments?: unknown }).environments : undefined
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const read: Array<Omit<StudioRelayedEnvironment, 'machine'>> = []
  for (const entry of list as unknown[]) {
    if (!entry || typeof entry !== 'object') continue
    const { environmentId, name, kind, connected, mark } = entry as Record<string, unknown>
    if (!isEnvironmentId(environmentId) || seen.has(environmentId)) continue
    if (typeof name !== 'string' || !name.trim() || name.length > RELAYED_NAME_MAX) continue
    if (kind !== 'ssh' && kind !== 'wsl') continue
    seen.add(environmentId)
    const whole = mark && typeof mark === 'object' ? (mark as Record<string, unknown>) : null
    read.push({
      environmentId,
      name,
      kind,
      connected: connected === true,
      ...(whole && typeof whole.kind === 'string' && typeof whole.color === 'string'
        ? { mark: { kind: whole.kind, color: whole.color } }
        : {}),
    })
  }
  return read
}

/**
 * The kinds of record a desktop hands over to the machine whose chats they
 * concern (`environment.adopt`), in the order they are kept: a workspace
 * first, so what names its chats finds them.
 */
export const STUDIO_ADOPTED_RECORD_KINDS = [
  'workspace',
  'chat',
  'approval-rule',
  'schedule',
  'scheduled-message',
  'usage-limit-resume',
  'pull-request',
] as const

export type StudioAdoptedRecordKind = (typeof STUDIO_ADOPTED_RECORD_KINDS)[number]

/**
 * One record handed over: its kind, its id there, the sha-256 of its body as
 * canonical JSON (keys sorted, no spaces), and the body in the machine's own
 * spelling of its paths. What each body holds is the record as the desktop's
 * own store keeps it: a workspace record; a scheduled agent; a scheduled or
 * held message; `{ workspaceId, agentId }` for a usage-limit resume to keep
 * scheduled; `{ workspaceId, agentId, url, title?, watched?, untold? }` for
 * a pull request a chat opened, `untold` being the news its watch found that
 * the chat has not been told yet.
 *
 * A chat the desktop ran itself (`chat`, id `<workspaceId>:<agentId>`) is
 * `{ workspaceId, agentId, workspaceRoot, files }`: each file the chat keeps,
 * `{ place, path, sha256, bytes, parts }`. `place` is `store` (a path under
 * the chat's workspace store's `conversations/<workspaceId>/`: its
 * transcript, its tools' details, its handoffs) or `attachments`, `images`
 * or `plans` (`<folder>/<file>` in that store of the data directory); `parts`
 * are the sha-256s of its pieces, in order, each staged through `uploads.*`
 * (`MAX_ADOPTED_PART_BYTES`). A saved approval (`approval-rule`, id the
 * rule's) is the rule as the desktop keeps it.
 *
 * A held message's pictures and files travel beside the records
 * (`StudioAdoptedFile`): its body names each in `carried.images` and
 * `carried.files` by the sha-256 of its bytes, and the call stages each once
 * through `uploads.*` and names its upload by that digest.
 */
export type StudioAdoptedRecord = {
  kind: StudioAdoptedRecordKind
  id: string
  digest: string
  body: Record<string, unknown>
}

/** A file a handed-over record carries: an upload this connection staged, by the sha-256 of its bytes. */
export type StudioAdoptedFile = { uploadId: string; digest: string }

/** What a hand-over came to: what the machine now keeps, and what it kept its own copy of instead, and why. */
export type StudioAdoptResult = {
  held: Array<{ kind: StudioAdoptedRecordKind; id: string }>
  conflicts: Array<{ kind: StudioAdoptedRecordKind; id: string; reason: string }>
}

/** The most records one hand-over carries; a longer one is sent in parts under the same migration. */
export const MAX_ADOPTED_RECORDS = 500

/** The most files one hand-over call stages beside its records: as many as a client may stage at once. */
export const MAX_ADOPTED_FILES = 16

/**
 * The largest piece of a chat's file one upload carries. A call that stages
 * files and names no record keeps them for the records that follow under the
 * same migration, so a transcript of any size goes in parts.
 */
export const MAX_ADOPTED_PART_BYTES = 4 * 1024 * 1024

/**
 * What a Studio is doing that stopping it would end: a chat working (starting,
 * mid-turn, waiting on a person, or running background agents, shells or
 * monitors), and the work it does on its own with no client and no chat
 * working: schedules with a run to come, pull request watches, messages kept
 * to send later, resumes after a usage limit.
 */
export type StudioEnvironmentWork = {
  working: boolean
  schedules: Array<{ id: string; title: string; nextRunAt: number }>
  watches: Array<{ url: string; title: string }>
  /** Messages kept to send into a chat later (scheduled, or held for a turn's end). */
  messages: number
  /** Chats a usage limit stopped, with a resume set for when it resets. */
  resumes: number
}

/** A sign-in that started: its link, the code to type there, and whether a code is pasted back. */
export type StudioSignInStarted =
  { ok: true; id: string; url: string; code: string | null; paste: boolean } | { ok: false; message: string }

/** How a sign-in ended. */
export type StudioSignInDone = { ok: true } | { ok: false; message: string }

export type StudioEnvironmentAccessMethodMap = {
  /**
   * The machines this desktop relays its paired devices to, each one a
   * `relay:` route for a device: listed to whoever may read chats here, since
   * reaching one still needs its own ticket, held to that device's grant.
   */
  'environment.relayed': { params: Record<string, never>; result: { environments: StudioRelayedEnvironment[] } }
  /**
   * What stopping this Studio would end, asked by the desktop that holds it:
   * before it stops a WSL distribution's server for being idle, and for the
   * quit question that names what stops with it.
   */
  'environment.work': { params: Record<string, never>; result: StudioEnvironmentWork }
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
  /**
   * Keep records the desktop that holds this Studio kept for its chats, so
   * they go on here with no desktop watching (design-environment-migration).
   * Safe to repeat: a record already kept under the same digest is held
   * again and nothing changes; one already here under another is left as
   * this Studio has it and reported. Answered only for what is on disk.
   */
  'environment.adopt': {
    params: { commandId: string; migrationId: string; records: StudioAdoptedRecord[]; files?: StudioAdoptedFile[] }
    result: StudioAdoptResult
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
const ADOPTS =
  'It writes this Studio’s own stores with the records the desktop that holds it kept, so only that desktop asks.'
const HOLDS =
  'It names this Studio’s schedules and watched pull requests, for the desktop that holds it to decide whether to stop it.'
const SIGNS_IN = 'It runs a CLI’s login on this machine and keeps its credential here.'

const signIn = {
  scope: 'settings:write',
  mutation: true,
  capability: STUDIO_PROVIDER_SIGN_IN_FLOW_CAPABILITY,
  owner: SIGNS_IN,
} as const

export const STUDIO_ENVIRONMENT_ACCESS_METHODS: StudioMethodTable<StudioEnvironmentAccessMethodMap> = {
  'environment.relayed': {
    scope: 'conversation:read',
    mutation: false,
    capability: STUDIO_RELAYED_ENVIRONMENTS_CAPABILITY,
    params: () => studioParams({}),
  },
  'environment.work': {
    scope: null,
    mutation: false,
    capability: STUDIO_ENVIRONMENT_WORK_CAPABILITY,
    owner: HOLDS,
    shell: HOLDS,
    params: () => studioParams({}),
  },
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
  'environment.adopt': {
    scope: null,
    mutation: true,
    capability: STUDIO_ENVIRONMENT_ADOPT_CAPABILITY,
    owner: ADOPTS,
    shell: ADOPTS,
    params: (value) => {
      if (!commandId(value)) return studioParamsRefused(COMMAND_ID)
      if (!(typeof value.migrationId === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value.migrationId)))
        return studioParamsRefused('"migrationId" names the hand-over: 1 to 128 of [A-Za-z0-9_-].')
      const given = value.records
      // None, only when it stages parts for the records that follow.
      const least = Array.isArray(value.files) && value.files.length > 0 ? 0 : 1
      if (!Array.isArray(given) || given.length < least || given.length > MAX_ADOPTED_RECORDS)
        return studioParamsRefused(
          `"records" holds 1 to ${MAX_ADOPTED_RECORDS} records, or none when "files" stages parts for the records that follow.`,
        )
      const kinds: readonly string[] = STUDIO_ADOPTED_RECORD_KINDS
      const records: StudioAdoptedRecord[] = []
      for (const entry of given) {
        const record = entry as Record<string, unknown> | null
        if (
          !record ||
          typeof record !== 'object' ||
          typeof record.kind !== 'string' ||
          !kinds.includes(record.kind) ||
          !text(record.id, 200) ||
          !(typeof record.digest === 'string' && /^[0-9a-f]{64}$/u.test(record.digest)) ||
          !record.body ||
          typeof record.body !== 'object' ||
          Array.isArray(record.body)
        )
          return studioParamsRefused(
            'Each record is { kind, id, digest, body }: a kind this Studio keeps, its id, the sha-256 of its body, and the body.',
          )
        records.push({
          kind: record.kind as StudioAdoptedRecordKind,
          id: record.id,
          digest: record.digest,
          body: record.body as Record<string, unknown>,
        })
      }
      const staged = value.files
      if (
        staged !== undefined &&
        !(
          Array.isArray(staged) &&
          staged.length <= MAX_ADOPTED_FILES &&
          staged.every(
            (file) =>
              file !== null &&
              typeof file === 'object' &&
              text((file as Record<string, unknown>).uploadId, 200) &&
              /^[0-9a-f]{64}$/u.test(String((file as Record<string, unknown>).digest)),
          )
        )
      )
        return studioParamsRefused(
          `"files" lists at most ${MAX_ADOPTED_FILES} { uploadId, digest }: an upload this connection staged and the sha-256 of its bytes.`,
        )
      const files = (staged as StudioAdoptedFile[] | undefined)?.map(({ uploadId, digest }) => ({ uploadId, digest }))
      return studioParams({
        commandId: value.commandId as string,
        migrationId: value.migrationId,
        records,
        ...(files?.length ? { files } : {}),
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
