import type { StudioErrorBody, StudioErrorCode } from './envelope.js'
import type { StudioCapability } from './handshake.js'
import type { StudioPermission } from './permissions.js'
import type { StudioScope } from './scopes.js'

// How a method and a stream topic are defined, once, so that one table builds
// both ends of the protocol.
//
// A family of methods (`chat.ts`, `files.ts`, …) writes a contract per method
// in a type map: what it takes, what it answers, and the refusals of its own
// it may answer with beyond the ones every method may. Its table then gives
// each method a definition: the scope it needs and the validator its params
// are read by. The table is typed over the map's keys, so a method with no
// scope or no validator does not compile, and a validator that answers
// anything but the method's params does not either.
//
// From the merged table (`methods.ts`) come the server's handler map, which
// must hold a handler for every method answering that method's result
// (`StudioHandlers`), and the client, whose calls take and answer the same
// types (`StudioRpcClient`). The handler map casts nothing. What casts are
// left sit where one generic call is paired with its method's definition (the
// dispatch to a handler, `createStudioRpcClient`, a client's own transport).
//
// What the types check is each member a contract defines: present, and of its
// type. They do not forbid a member it does not define (TypeScript's types are
// not exact), so dropping unknown members is each validator's own work, which
// its tests hold it to, and a handler answers what the backend gave it.

/** One method: what it takes, what it answers, and the refusals of its own it may answer with. */
export type StudioMethodContract = {
  params: object
  result: unknown
  /** Codes beyond `StudioCommonErrorCode` this method may answer with. */
  errors?: StudioErrorCode
}

/**
 * The refusals any method may answer with: its params, its name, the grant,
 * the connection's limits, Studio being unable to carry it out, and a command
 * id already used for another command.
 */
export type StudioCommonErrorCode =
  | 'invalid_params'
  | 'unknown_method'
  | 'scope_required'
  | 'owner_required'
  | 'unavailable'
  | 'busy'
  | 'too_large'
  | 'command_id_conflict'

/** How a method is held: the scope a grant needs, whether it mutates, the capability that offers it. */
export type StudioMethodSpec = {
  /** The scope a client asks to be granted for it; null for what any authenticated client may ask. */
  scope: StudioScope | null
  /**
   * What it needs beyond the permission its scope names, which it always
   * needs (`studioSpecPermissions`): a method can need more than its scope
   * carries, never less.
   */
  extraPermissions?: readonly StudioPermission[]
  /** A mutation carries a `commandId`, is audited, and is answered from its receipt on a retry. */
  mutation: boolean
  /** The capability a client checks before calling it. */
  capability: StudioCapability | null
  /**
   * Only an owner's connection may call it, whatever scopes another grant
   * holds, and why: it runs a program or opens a terminal on this machine, or
   * records what only Studio's own agents report. Everything else reaches a
   * paired client by its scope.
   */
  owner?: string
  /**
   * Only the desktop's own shell connection may call it, and why: it hands out
   * what admits a window of Studio's own. Always with `owner`, which every
   * other non-owner refusal reads; this refuses the owner's other clients too
   * (a web tab, a paired app).
   */
  shell?: string
  /**
   * Only Studio's own desktop windows may call it, and why: its answer
   * carries a credential, or it lets someone reach this machine from
   * elsewhere. Always with `owner`; this refuses the owner's other clients
   * too: a web tab (a stolen browser session must not mint the next way in),
   * an app or script holding the owner's credential, and the shell.
   */
  window?: string
}

/**
 * Why a request's params were refused: not in the method's shape, over a
 * limit, or (an approval's `always`) a decision no remote client makes.
 */
export type StudioParamsRefusalCode = 'invalid_params' | 'too_large' | 'unsafe_remote_decision'

/** Why a request's params were refused. */
export type StudioParamsRefusal = { ok: false; code: StudioParamsRefusalCode; message: string }

/** A validator's answer: the params in the method's own shape, members it does not define dropped, or why not. */
export type StudioParsed<P> = { ok: true; params: P } | StudioParamsRefusal

/** A method's definition: how it is held, and the validator its params are read by. */
export type StudioMethodDefinition<C extends StudioMethodContract> = StudioMethodSpec & {
  /**
   * Reads an object of params (absent params arrive as `{}`) into the method's
   * shape, building it member by member so that members it does not define
   * are dropped.
   */
  readonly params: (value: Record<string, unknown>) => StudioParsed<C['params']>
}

/** A family's table: a definition for every method its map names. */
export type StudioMethodTable<Map extends { [M in keyof Map]: StudioMethodContract }> = {
  readonly [M in keyof Map]: StudioMethodDefinition<Map[M]>
}

/** Every code a method of the map may answer with. */
export type StudioErrorCodeOf<C extends StudioMethodContract> =
  StudioCommonErrorCode | (C extends { errors: infer E } ? E : never)

/** A refusal of a method, with a code it declares. */
export type StudioErrorOf<C extends StudioMethodContract> = StudioErrorBody & { code: StudioErrorCodeOf<C> }

/** A method's answer, as the server's handler gives it. */
export type StudioAnswerOf<C extends StudioMethodContract> =
  { ok: true; result: C['result'] } | { ok: false; error: StudioErrorOf<C> }

/** The server's handler for one method: its params as its validator read them, and who asked. */
export type StudioHandlerOf<C extends StudioMethodContract, Context> = (
  params: C['params'],
  context: Context,
) => StudioAnswerOf<C> | Promise<StudioAnswerOf<C>>

/** A handler for every method of the map: one missing, or answering another shape, does not compile. */
export type StudioHandlersOf<Map extends { [M in keyof Map]: StudioMethodContract }, Context> = {
  readonly [M in keyof Map]: StudioHandlerOf<Map[M], Context>
}

/** A client's one way to call: a method, its params, and the answer it promises. */
export type StudioRequestOf<Map extends { [M in keyof Map]: StudioMethodContract }> = <M extends keyof Map & string>(
  method: M,
  params: Map[M]['params'],
) => Promise<Map[M]['result']>

/** A call per method, built from the table, each taking that method's params and answering its result. */
export type StudioRpcClientOf<Map extends { [M in keyof Map]: StudioMethodContract }> = {
  readonly [M in keyof Map]: (params: Map[M]['params']) => Promise<Map[M]['result']>
}

// ── Topics ──────────────────────────────────────────────────────────────────

/**
 * One stream topic: what subscribing takes, and what each message carries. A
 * `push` topic's messages are `{ t: 'push', sub, payload }`, each whole; a
 * `frames` topic's are conversation frames under `{ t: 'frame' }`.
 */
export type StudioTopicContract = { params: object; payload: unknown; stream: 'push' | 'frames' }

/** How a topic is held, as a method is, and the validator its params are read by. */
export type StudioTopicDefinition<C extends StudioTopicContract> = {
  /** As for a method: null where no scope is asked for (an owner's only stream names `owner`). */
  scope: StudioScope | null
  /** What it needs beyond its scope's permission, as for a method. */
  extraPermissions?: readonly StudioPermission[]
  capability: StudioCapability
  /** As for a method: why only an owner may follow it. */
  owner?: string
  /** As for a method: why only Studio's own desktop windows may follow it. */
  window?: string
  /** Reads an object of params; absent params are read as `{}`, which a topic that names something refuses. */
  readonly params: (value: Record<string, unknown>) => StudioParsed<C['params']>
} & (C['stream'] extends 'push' ? { push: true } : { push?: never })

export type StudioTopicTable<Map extends { [T in keyof Map]: StudioTopicContract }> = {
  readonly [T in keyof Map]: StudioTopicDefinition<Map[T]>
}

// ── Validator helpers ───────────────────────────────────────────────────────

/** Params accepted as read. */
export function studioParams<P>(params: P): { ok: true; params: P } {
  return { ok: true, params }
}

/** Params refused, `invalid_params` unless said otherwise. */
export function studioParamsRefused(
  message: string,
  code: StudioParamsRefusalCode = 'invalid_params',
): StudioParamsRefusal {
  return { ok: false, code, message }
}

/** The validator of a method or topic that takes nothing: whatever is sent is dropped. */
export function studioNoParams(): { ok: true; params: Record<string, never> } {
  return { ok: true, params: {} }
}
