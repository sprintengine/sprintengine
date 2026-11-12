// The methods a module declares: what its main half serves, and what its
// renderer half (or any client the person granted it) calls, over the Studio
// protocol's `module.read` and `module.operate`
// (packages/studio-protocol/src/modules.ts).
//
// A module writes a contract per method, a type: who may call it (`access`),
// what it takes, what it answers, and the refusals of its own it may answer
// with. Its main half registers each with a validator for its params and a
// handler (`MainHost.registerMethods`); its renderer half calls them through
// `RendererHost.methods<Contract>()`, which only offers a `read` method to
// `read` and an `operate` one to `operate`. The SDK restates these types
// (packages/module-sdk/src/index.ts); the drift guard holds the two equal.

import {
  STUDIO_MODULE_METHOD_MAX_CHARS,
  isStudioModuleMethodName,
} from '../../../packages/studio-protocol/src/modules'

export { STUDIO_MODULE_METHOD_MAX_CHARS as MODULE_METHOD_MAX_CHARS, isStudioModuleMethodName as isModuleMethodName }

/**
 * Who may call a method. `read` answers without changing anything, and a
 * client granted `modules:read` reaches it; `operate` may change something,
 * needs `modules:operate`, and is carried out once per command id.
 */
export type ModuleMethodAccess = 'read' | 'operate'

/** One method a module declares: who may call it, what it takes and answers, and its own refusals. */
export type ModuleMethodContract = {
  access: ModuleMethodAccess
  params: unknown
  result: unknown
  /** The codes of the module's own refusals, beyond the host's. */
  errors?: string
}

/** A module's methods, by name: a lower-case letter, then letters, digits, dots and dashes. */
export type ModuleMethodContracts = { [method: string]: ModuleMethodContract }

/** What a method's params validator answers: the params in the method's shape, or why not. */
export type ModuleMethodParsed<P> = { ok: true; params: P } | { ok: false; message: string }

/** The codes of a contract's own refusals; `string` when it names none. */
export type ModuleMethodErrorCode<C extends ModuleMethodContract> = C extends { errors: infer E extends string }
  ? E
  : string

/** What a method's handler answers: its result, or one of its own refusals. Results must be JSON. */
export type ModuleMethodAnswer<C extends ModuleMethodContract> =
  { ok: true; result: C['result'] } | { ok: false; code: ModuleMethodErrorCode<C>; message: string }

/** Who called a method, as the host tells its handler. */
export type ModuleMethodContext = {
  /** The Studio client that called: `owner` for Studio's own windows, else the paired client's id. */
  clientId: string
  /**
   * An `operate` call's command id, namespaced by the client (`owner:<id>`,
   * `client:<clientId>:<id>`): the same on every retry of the call, so a
   * handler that sends to a chat passes it on and a retry is answered from the
   * chat's receipt rather than sent twice. Absent for a `read`.
   */
  commandId?: string
}

/** One method as the main half registers it. */
export type ModuleMethodRegistration<C extends ModuleMethodContract = ModuleMethodContract> = {
  access: C['access']
  /** Reads what a client sent (any JSON value, or `undefined`) into the method's params, or refuses it. */
  params: (value: unknown) => ModuleMethodParsed<C['params']>
  handler: (
    params: C['params'],
    context: ModuleMethodContext,
  ) => ModuleMethodAnswer<C> | Promise<ModuleMethodAnswer<C>>
}

/** A registration for every method of a contract. */
export type ModuleMethodRegistrations<Cs extends ModuleMethodContracts = ModuleMethodContracts> = {
  [M in keyof Cs & string]: ModuleMethodRegistration<Cs[M]>
}

/**
 * The host's refusals of a call, beside the module's own: the module does not
 * run on this Studio (not installed, switched off, refused or failed to load),
 * declares no such method under the entry called, refused the params, or the
 * window's grant or connection does not reach it.
 */
export type ModuleCallRefusalCode =
  | 'module_unavailable'
  | 'module_method_unknown'
  | 'invalid_params'
  | 'scope_required'
  | 'unavailable'

/** What a call answers a renderer: the method's result, its own refusal, or the host's. */
export type ModuleCallAnswer<C extends ModuleMethodContract> =
  | { ok: true; result: C['result'] }
  | { ok: false; code: ModuleMethodErrorCode<C> | ModuleCallRefusalCode; message: string }

/** The names of a contract's methods a client may call with `read`. */
export type ModuleReadMethod<Cs extends ModuleMethodContracts> = {
  [M in keyof Cs & string]: 'read' extends Cs[M]['access'] ? M : never
}[keyof Cs & string]

/** The names of a contract's methods a client may call with `operate`. */
export type ModuleOperateMethod<Cs extends ModuleMethodContracts> = {
  [M in keyof Cs & string]: 'operate' extends Cs[M]['access'] ? M : never
}[keyof Cs & string]

/** A renderer's calls to its own module's methods, typed by the module's contract. */
export type ModuleMethodsClient<Cs extends ModuleMethodContracts = ModuleMethodContracts> = {
  /** Call a `read` method. Never throws: a refusal is an answer. */
  read<M extends ModuleReadMethod<Cs>>(method: M, params: Cs[M]['params']): Promise<ModuleCallAnswer<Cs[M]>>
  /**
   * Call an `operate` method. Each call is its own command unless `commandId`
   * is given: a retry under the same id is answered with the first answer.
   * Never throws.
   */
  operate<M extends ModuleOperateMethod<Cs>>(
    method: M,
    params: Cs[M]['params'],
    options?: { commandId?: string },
  ): Promise<ModuleCallAnswer<Cs[M]>>
}
