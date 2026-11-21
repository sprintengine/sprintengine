// One host call an extension's frame made (`studio.host.call`), as the
// Studio protocol's `extension.call` hands it to the kernel: the method's row
// (EXTENSION_FRAME_METHODS), the host's gate as the extension and as the
// connection whose client drew the frame, then the call itself against the
// same services the extension's worker reaches.
//
// A `client` method (a toast, a drafted chat, opening a door) is only admitted
// here; the client that drew the frame carries it out when the answer says so.
// Refusals and failures are answers, `{ ok: false, code, message }`, which the
// frame's bridge turns into a rejected call with that code.

import { extensionFrameMethod } from '../../../packages/extension-sdk/src/services'
import type { ExtensionFrameMethod } from '../../../packages/extension-sdk/src/frame'
import type {
  ModuleMethodAccess,
  ModuleNotifyInput,
  ModuleWorkspaceView,
  WorkspaceContextService,
} from '../../../packages/extension-sdk/src/index'
import type { StudioExtensionCallAnswer } from '../../../packages/studio-protocol/src/public'
import { gateExtensionHostCall } from './extension-host-gate'
import { runAsInvoker, type ExtensionInvoker } from './extension-invocation'
import {
  ExtensionFileRefusal,
  readExtensionFile,
  searchExtensionFiles,
  statExtensionFile,
  writeExtensionFile,
} from './extension-files'
import type { ModuleMethodCallOutcome, ModuleMethodCallRequest } from './main-host'
import type { ModuleAppStateMirror } from './module-app-state-mirror'
import { moduleEventPayloadProblem } from '../../shared/modules/events'

/** One frame call, as the router hands it over. */
export type ExtensionFrameCallRequest = {
  moduleId: string
  method: string
  params: unknown
  clientId: string
  commandId: string
  /** The connection whose client drew the frame. */
  invoker: ExtensionInvoker
}

export type ExtensionFrameCallDeps = {
  /**
   * The permissions an extension's approval holds now, read at each call: null
   * when it is not an installed extension that is approved as it is and
   * switched on. Read from the approvals and the switches as they stand, not
   * as they stood when the kernel started, so one installed or approved
   * during the session is served at once and one revoked is refused at once.
   */
  grantOf(moduleId: string): readonly string[] | null
  /** A service the host's parts provide, by key. */
  service(key: string): unknown
  callModuleMethod(request: ModuleMethodCallRequest): Promise<ModuleMethodCallOutcome>
  emitNotification(moduleId: string, input: ModuleNotifyInput): void
  /** The extensions' Settings values. */
  appState(): Pick<ModuleAppStateMirror, 'get' | 'setValue'> | undefined
  /** Folders no `files.*` call may reach even inside a workspace. */
  fileExclusions(): readonly string[]
}

/** The frame methods the window that drew the frame carries out. */
type ClientFrameMethod = 'toast' | 'chat.draft' | 'doors.open' | 'tabs.focus'

/** The longest Settings key, and the most a Settings value may hold. */
const MAX_SETTING_KEY_CHARS = 200
const MAX_SETTING_VALUE_BYTES = 64 * 1024

class CallRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const invalid = (message: string) => new CallRefusal('invalid_params', message)

function record(params: unknown): Record<string, unknown> {
  if (params === undefined) return {}
  if (params === null || typeof params !== 'object' || Array.isArray(params))
    throw invalid('A host call takes its params as an object.')
  return params as Record<string, unknown>
}

function text(params: Record<string, unknown>, name: string, max = 4096): string {
  const value = params[name]
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw invalid(`"${name}" is a string.`)
  return value
}

type Registry = Record<string, (...args: unknown[]) => Promise<unknown>>

export function createExtensionFrameCalls(deps: ExtensionFrameCallDeps) {
  function registry(key: string): Registry {
    const found = deps.service(key) as Registry | undefined
    if (!found) throw new CallRefusal('unavailable', 'This Studio does not provide that to extensions.')
    return found
  }
  function workspaces(): WorkspaceContextService {
    return registry('core.workspace-context') as unknown as WorkspaceContextService
  }
  async function workspace(workspaceId: unknown): Promise<ModuleWorkspaceView & { folderPath: string }> {
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) throw invalid('"workspaceId" is a workspace’s id.')
    const found = await workspaces().get(workspaceId)
    if (!found?.folderPath) throw new CallRefusal('action_failed', 'That workspace is not open here, or has no folder.')
    return found as ModuleWorkspaceView & { folderPath: string }
  }
  async function storageInput(params: Record<string, unknown>, more: Record<string, unknown>) {
    return {
      ...more,
      ...(params.workspaceId === undefined ? {} : { workspaceRoot: (await workspace(params.workspaceId)).folderPath }),
    }
  }
  async function filesScope(params: Record<string, unknown>) {
    return { root: (await workspace(params.workspaceId)).folderPath, forbidden: deps.fileExclusions() }
  }
  function settings() {
    const store = deps.appState()
    if (!store) throw new CallRefusal('unavailable', 'This Studio keeps no Settings values for extensions.')
    return store
  }
  async function worker(
    request: ExtensionFrameCallRequest,
    access: ModuleMethodAccess,
    params: Record<string, unknown>,
  ) {
    const outcome = await deps.callModuleMethod({
      moduleId: request.moduleId,
      method: text(params, 'method', 100),
      access,
      params: params.params,
      clientId: request.clientId,
      ...(access === 'operate' ? { commandId: request.commandId } : {}),
      invoker: request.invoker,
    })
    return outcome.ok ? outcome.answer : { ok: false, code: outcome.code, message: outcome.message }
  }

  type Served = (request: ExtensionFrameCallRequest, params: Record<string, unknown>) => unknown
  const backlog =
    (name: string, ...fields: string[]): Served =>
    (request, params) =>
      registry('backlog.module-service')[name]!(request.moduleId, ...fields.map((field) => params[field]))
  // Every server method of the table has its implementation here: one added
  // to the table and not here fails to compile.
  const served: Record<Exclude<ExtensionFrameMethod, ClientFrameMethod>, Served> = {
    'workspace.list': () => workspaces().list(),
    'workspace.get': (_request, params) => workspaces().get(text(params, 'workspaceId', 400)),
    'backlog.list': backlog('list', 'workspaceId'),
    'backlog.location': backlog('getLocation', 'workspaceId'),
    'backlog.create': backlog('create', 'workspaceId', 'input'),
    'backlog.updateStatus': backlog('updateStatus', 'workspaceId', 'itemId', 'status'),
    'backlog.updateTriage': backlog('updateTriage', 'workspaceId', 'itemId', 'triage'),
    'backlog.addLink': backlog('addLink', 'workspaceId', 'itemId', 'link'),
    'backlog.updateModuleMetadata': backlog('updateModuleMetadata', 'workspaceId', 'itemId', 'value'),
    'usage.query': (request, params) => registry('usage.module-service').query!(request.moduleId, params.query),
    'storage.get': async (request, params) =>
      registry('core.module-storage').get!(request.moduleId, await storageInput(params, { key: params.key })),
    'storage.set': async (request, params) =>
      registry('core.module-storage').set!(
        request.moduleId,
        await storageInput(params, { key: params.key, value: params.value }),
      ),
    'storage.delete': async (request, params) =>
      registry('core.module-storage').delete!(request.moduleId, await storageInput(params, { key: params.key })),
    'storage.list': async (request, params) =>
      registry('core.module-storage').list!(
        request.moduleId,
        await storageInput(params, params.prefix === undefined ? {} : { prefix: params.prefix }),
      ),
    'settings.get': (request) => ({ ...settings().get(request.moduleId) }),
    'settings.set': (request, params) => {
      const key = text(params, 'key', MAX_SETTING_KEY_CHARS)
      const value = params.value
      if (value !== null && value !== undefined) {
        const problem = moduleEventPayloadProblem(value, 'value')
        if (problem) throw invalid(problem)
        if (JSON.stringify(value).length > MAX_SETTING_VALUE_BYTES) throw invalid('A Settings value is at most 64 KiB.')
      }
      settings().setValue(request.moduleId, key, value === null ? undefined : value)
      return { ok: true }
    },
    'files.read': async (_request, params) => readExtensionFile(await filesScope(params), params.path),
    'files.stat': async (_request, params) => statExtensionFile(await filesScope(params), params.path),
    'files.search': async (_request, params) =>
      searchExtensionFiles(await filesScope(params), params.query, params.limit),
    'files.write': async (_request, params) =>
      writeExtensionFile(await filesScope(params), params.path, params.content, params.create === true),
    notify: (request, params) => {
      try {
        deps.emitNotification(request.moduleId, params as ModuleNotifyInput)
      } catch (error) {
        throw invalid(error instanceof Error ? error.message : String(error))
      }
      return { ok: true }
    },
    'worker.read': (request, params) => worker(request, 'read', params),
    'worker.operate': (request, params) => worker(request, 'operate', params),
  }

  return async function callFrameMethod(request: ExtensionFrameCallRequest): Promise<StudioExtensionCallAnswer> {
    const requirement = extensionFrameMethod(request.method)
    if (!requirement)
      return {
        ok: false,
        code: 'unknown_method',
        message: `"${request.method}" is not a host method a frame may call.`,
      }
    const decision = gateExtensionHostCall({
      extensionId: request.moduleId,
      method: request.method,
      requirement,
      grant: deps.grantOf(request.moduleId),
      invoker: request.invoker,
    })
    if (!decision.ok) return { ok: false, code: decision.code, message: decision.message }
    // Admitted: the window that drew the frame carries a client method out.
    if (requirement.runs === 'client') return { ok: true, result: null }
    try {
      const params = record(request.params)
      const serve = served[request.method as keyof typeof served]
      const result = await runAsInvoker(request.invoker, () => serve(request, params))
      return { ok: true, result: result ?? null }
    } catch (error) {
      if (error instanceof CallRefusal || error instanceof ExtensionFileRefusal)
        return { ok: false, code: error.code, message: error.message }
      return {
        ok: false,
        code: 'action_failed',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
