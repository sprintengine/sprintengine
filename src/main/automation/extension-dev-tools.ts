import { isAbsolute } from 'node:path'

import { isExtensionHookPoint } from '../../../packages/extension-sdk/src/hooks'
import {
  isRecord,
  toolError,
  toolSuccess,
  type McpConnectionContext,
  type McpToolRegistration,
  type McpToolResult,
} from '../../shared/modules/mcp-tools'
import { currentInvoker, runAsInvoker, type ExtensionInvoker } from '../module-host/extension-invocation'
import { isMostPermissiveCliPermissionPreset } from '../../shared/cli-permission-preset'
import type { ModuleMethodCallOutcome, ModuleMethodCallRequest } from '../module-host/main-host'
import type { ModuleLifecycle } from '../modules/module-lifecycle'
import { extensionDevEvents, type ExtensionDevEvents } from '../../server/extensions/dev/dev-events'

// The extension dev loop, as tools on the Studio's gateway: what
// `sprintengine-extension dev …` calls over the local socket, and what an
// agent with Studio's tools calls itself.
//
//   extension.dev.load     register a development folder (or read it again)
//   extension.dev.unload   take one out
//   extension.dev.list     the development folders and how each stands
//   extension.dev.events   what happened since a number: logs, reloads, status, approval
//   extension.dev.request  call one of its worker's methods, as a frame does
//   extension.dev.hook     run one of its worker's hooks with a made-up event
//   extension.dev.emit     send its open frames a push, as its worker would
//
// Development folders are paths on this machine, so a paired device's call is
// refused. An agent may register a folder, but nothing here approves one: the
// person does, in Studio's window, where a registration that waits asks them
// (or in Settings > Extensions). `request`, `hook` and `emit` reach only a
// registered development folder's extension, never an installed one, and run
// as their caller (`bindDevToolsToCaller`): what a worker starts for a capped
// agent is no looser than that agent.

export const EXTENSION_DEV_TOOL_NAMES = [
  'extension.dev.load',
  'extension.dev.unload',
  'extension.dev.list',
  'extension.dev.events',
  'extension.dev.request',
  'extension.dev.hook',
  'extension.dev.emit',
] as const

/** Change something: registering, removing, a worker's operate, a hook, a push. */
export const EXTENSION_DEV_MUTATION_TOOL_NAMES: readonly string[] = [
  'extension.dev.load',
  'extension.dev.unload',
  'extension.dev.request',
  'extension.dev.hook',
  'extension.dev.emit',
]

/** What the tools reach of the Studio that serves them; null before its extensions load. */
export type ExtensionDevBackend = {
  lifecycle(): ModuleLifecycle | null
  callModuleMethod(request: ModuleMethodCallRequest): Promise<ModuleMethodCallOutcome>
  /** Start the worker if it is not running, then run its handler for `point`. */
  runHook(moduleId: string, point: string, event: unknown, invoker: ExtensionInvoker): Promise<unknown>
  /** Deliver a push to the extension's open frames, as `MainHost.emit` does. */
  emit(moduleId: string, topic: string, payload: unknown): void
}

export type ExtensionDevToolsDeps = {
  backend: () => ExtensionDevBackend | null
  events?: ExtensionDevEvents
}

const HOOK_TIMEOUT_MS = 10_000

/** A refusal with what the caller may act on: the issues, the folders, the worker's own code. */
function devError(code: string, message: string, data?: Record<string, unknown>): McpToolResult {
  const error = toolError(code, message)
  if (!data) return error
  return { ...error, structuredContent: { ok: false, error: { code, message, data } } }
}

function refusedRemote(context: McpConnectionContext | undefined): McpToolResult | null {
  return context?.metadata.kind === 'remote-tailnet'
    ? toolError(
        'not_permitted',
        'Development folders are paths on the machine Studio runs on; a paired device cannot use them.',
      )
    : null
}

/** The tools that run extension code for their caller: run as that caller. */
const RUN_AS_CALLER = new Set(['extension.dev.request', 'extension.dev.hook'])
/** Answered by the desktop shell over its own connection, which holds no caller: refused to a capped one. */
const REFUSED_TO_CAPPED = new Set(['visual.extension_shot'])

/**
 * The gateway's tools with the dev loop's held to who calls them: a request
 * or a hook runs as its caller (an agent here is the person under its own
 * launch ceiling), so a chat the worker starts for a `manual` agent runs on
 * `manual`. A shot's surface calls are answered over the shell's own
 * connection, which cannot carry a ceiling, so a capped agent is refused one.
 */
export function bindDevToolsToCaller(
  tools: McpToolRegistration[],
  callerInvoker: (context: McpConnectionContext | undefined) => ExtensionInvoker,
): McpToolRegistration[] {
  return tools.map((tool) => {
    if (RUN_AS_CALLER.has(tool.name))
      return {
        ...tool,
        handler: (args, context) => runAsInvoker(callerInvoker(context), () => tool.handler(args, context)),
      }
    if (REFUSED_TO_CAPPED.has(tool.name))
      return {
        ...tool,
        handler: (args, context) => {
          const ceiling = callerInvoker(context).permissionCeiling
          if (ceiling !== null && !isMostPermissiveCliPermissionPreset(ceiling))
            return Promise.resolve(
              toolError(
                'not_permitted',
                `A picture runs the surface's calls as the person, and this agent runs on ${ceiling}: ask the person to take it (sprintengine-extension shot).`,
              ),
            )
          return tool.handler(args, context)
        },
      }
    return tool
  })
}

function stringArg(args: Record<string, unknown>, key: string, max = 4096): string | null {
  const value = args[key]
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value : null
}

function lifecycleOf(deps: ExtensionDevToolsDeps): ModuleLifecycle | McpToolResult {
  const lifecycle = deps.backend()?.lifecycle()
  return lifecycle ?? toolError('unavailable', 'This Studio’s extensions have not loaded yet; try again in a moment.')
}

const isResult = (value: unknown): value is McpToolResult =>
  isRecord(value) && Array.isArray((value as { content?: unknown }).content)

/** Whether `path` is `folder` or inside it, with either separator. */
export function isInFolder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`) || path.startsWith(`${folder}\\`)
}

/**
 * The development folder's extension a call names: `moduleId`, or the
 * development folder at `path`. An installed extension is refused: the dev
 * loop drives the author's own working copy, nothing the person installed.
 */
async function moduleIdOf(lifecycle: ModuleLifecycle, args: Record<string, unknown>): Promise<string | McpToolResult> {
  const moduleId = stringArg(args, 'moduleId', 200)
  const path = moduleId ? null : stringArg(args, 'path')
  if (!moduleId && !path)
    return toolError('invalid_arguments', 'Name the extension: "moduleId", or the development folder "path".')
  const folders = await lifecycle.devFolders()
  const waiting = (folder: { waiting?: boolean; moduleId?: string }) =>
    toolError(
      'approval_required',
      `${folder.moduleId} waits for the person to approve it in place of the installed extension with its key, in Studio's window.`,
    )
  if (moduleId) {
    const named = folders.find((folder) => folder.moduleId === moduleId)
    if (named?.waiting) return waiting(named)
    if (named) return moduleId
    return toolError(
      'not_found',
      `${moduleId} is not a development folder's extension here. The dev tools drive development folders only; installed extensions are refused.`,
    )
  }
  const found = folders.find((folder) => isInFolder(path!, folder.path))
  if (!found) return toolError('not_found', `${path} is not a development folder registered here.`)
  if (!found.moduleId) return toolError('extension_invalid', found.error ?? `${path} holds no extension Studio loads.`)
  if (found.waiting) return waiting(found)
  return found.moduleId
}

export function createExtensionDevTools(deps: ExtensionDevToolsDeps): McpToolRegistration[] {
  const events = deps.events ?? extensionDevEvents
  const pathSchema = {
    type: 'string',
    description: 'The development folder: an absolute path on the machine Studio runs on.',
  }
  const target = {
    moduleId: { type: 'string', description: 'The extension’s install key, `local.<id>`.' },
    path: pathSchema,
  }
  return [
    {
      name: 'extension.dev.load',
      description:
        'Register a folder holding an extension.json as a development folder: Studio loads it from where it is, ' +
        'with no build and no install copy, and reads it again on every save (its worker restarts, its panels ' +
        'redraw). Registering one already registered reads it again now. Nothing in it runs until the person ' +
        "approves it in Studio's window, which asks them as soon as it is registered (also Settings > Extensions): " +
        "the answer's `approval.state` is `pending` until then. Poll `extension.dev.list`, or follow " +
        '`extension.dev.events`, to see it approved. A save asks again only when it asks for more. One whose key an ' +
        'installed extension has stands in for it only once the person approves that; the installed one runs until then.',
      inputSchema: {
        type: 'object',
        properties: { path: pathSchema },
        required: ['path'],
        additionalProperties: false,
      },
      mutates: true,
      handler: async (args, context) => {
        const remote = refusedRemote(context)
        if (remote) return remote
        const path = stringArg(args, 'path')
        if (!path || !isAbsolute(path))
          return toolError('invalid_arguments', '"path" is the folder, as an absolute path on this machine.')
        if (args.approve !== undefined)
          return toolError(
            'invalid_arguments',
            "Nothing over this connection approves an extension: the person approves it in Studio's window.",
          )
        const lifecycle = lifecycleOf(deps)
        if (isResult(lifecycle)) return lifecycle
        const answer = await lifecycle.devLoad(path)
        if (!answer.ok)
          return devError(answer.code, answer.message, answer.issues ? { issues: answer.issues } : undefined)
        return toolSuccess({ ...answer, latestEvent: events.latest() })
      },
    },
    {
      name: 'extension.dev.unload',
      description: 'Take a development folder out of Studio (its files stay); its approval goes with it.',
      inputSchema: { type: 'object', properties: target, additionalProperties: false },
      mutates: true,
      handler: async (args, context) => {
        const remote = refusedRemote(context)
        if (remote) return remote
        const lifecycle = lifecycleOf(deps)
        if (isResult(lifecycle)) return lifecycle
        const moduleId = stringArg(args, 'moduleId', 200)
        const path = stringArg(args, 'path')
        if (!moduleId && !path) return toolError('invalid_arguments', 'Name the folder ("path") or its "moduleId".')
        const answer = await lifecycle.devUnload(moduleId ? { moduleId } : { path: path! })
        if (!answer.ok)
          return devError(answer.code, answer.message, answer.loaded ? { loaded: answer.loaded } : undefined)
        return toolSuccess(answer)
      },
    },
    {
      name: 'extension.dev.list',
      description:
        'The development folders registered here, in the order they load (after every installed extension), ' +
        'each with its extension, its approval and how it runs now.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      mutates: false,
      handler: async (_args, context) => {
        const remote = refusedRemote(context)
        if (remote) return remote
        const lifecycle = lifecycleOf(deps)
        if (isResult(lifecycle)) return lifecycle
        const [folders, installed] = await Promise.all([lifecycle.devFolders(), lifecycle.installed()])
        return toolSuccess({
          folders: folders.map((folder) => {
            const view = installed.modules.find((module) => module.manifest.id === folder.moduleId)
            return view ? { ...folder, launch: view.launch } : folder
          }),
          latestEvent: events.latest(),
        })
      },
    },
    {
      name: 'extension.dev.events',
      description:
        'What happened to extensions after event number `after` (0: everything kept): `log` lines from the worker ' +
        'and frames (errors at file:line:col), `reloaded` after a save, `status` changes, and `approval` when a ' +
        'save asks for more. Call again with the last `seq` you saw.',
      inputSchema: {
        type: 'object',
        properties: {
          after: { type: 'integer', minimum: 0 },
          moduleId: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      mutates: false,
      handler: async (args, context) => {
        const remote = refusedRemote(context)
        if (remote) return remote
        const after = typeof args.after === 'number' && args.after >= 0 ? Math.floor(args.after) : 0
        const limit = typeof args.limit === 'number' ? Math.min(500, Math.max(1, Math.floor(args.limit))) : 200
        const moduleId = stringArg(args, 'moduleId', 200) ?? undefined
        const found = events.since(after, moduleId, limit)
        return toolSuccess({ events: found, latest: events.latest() })
      },
    },
    {
      name: 'extension.dev.request',
      description:
        'Call one of an extension worker’s methods (`studio.registerMethods`) the way its frame’s ' +
        '`studio.methods().read/operate` does, starting the worker if it is not running, and answer what it answered.',
      inputSchema: {
        type: 'object',
        properties: {
          ...target,
          method: { type: 'string' },
          access: { type: 'string', enum: ['read', 'operate'] },
          params: {},
        },
        required: ['method'],
        additionalProperties: false,
      },
      mutates: true,
      handler: async (args, context) => {
        const remote = refusedRemote(context)
        if (remote) return remote
        const backend = deps.backend()
        const lifecycle = lifecycleOf(deps)
        if (isResult(lifecycle) || !backend)
          return isResult(lifecycle) ? lifecycle : toolError('unavailable', 'Not loaded yet.')
        const moduleId = await moduleIdOf(lifecycle, args)
        if (typeof moduleId !== 'string') return moduleId
        const method = stringArg(args, 'method', 100)
        if (!method) return toolError('invalid_arguments', '"method" is the name the worker registered.')
        const access = args.access === 'read' ? 'read' : 'operate'
        const outcome = await backend.callModuleMethod({
          moduleId,
          method,
          access,
          params: args.params,
          clientId: 'extension-dev',
          ...(access === 'operate' ? { commandId: `extension-dev:${Date.now().toString(36)}` } : {}),
          invoker: currentInvoker(),
        })
        if (!outcome.ok) return devError('extension_request_failed', outcome.message, { requestCode: outcome.code })
        return toolSuccess({ moduleId, method, result: outcome.answer })
      },
    },
    {
      name: 'extension.dev.hook',
      description:
        'Run one of an extension worker’s hooks (`contributes.hooks`) with an event you make up, as Studio runs it ' +
        'before an action, and answer what the hook decided. Nothing else in Studio happens.',
      inputSchema: {
        type: 'object',
        properties: { ...target, point: { type: 'string' }, event: {} },
        required: ['point', 'event'],
        additionalProperties: false,
      },
      mutates: true,
      handler: async (args, context) => {
        const remote = refusedRemote(context)
        if (remote) return remote
        const backend = deps.backend()
        const lifecycle = lifecycleOf(deps)
        if (isResult(lifecycle) || !backend)
          return isResult(lifecycle) ? lifecycle : toolError('unavailable', 'Not loaded yet.')
        const moduleId = await moduleIdOf(lifecycle, args)
        if (typeof moduleId !== 'string') return moduleId
        const point = stringArg(args, 'point', 100)
        if (!point || !isExtensionHookPoint(point))
          return toolError('invalid_arguments', `"${String(args.point)}" is not a hook point.`)
        try {
          const answer = await Promise.race([
            backend.runHook(moduleId, point, args.event, currentInvoker()),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error(`The hook did not answer within ${HOOK_TIMEOUT_MS / 1000}s.`)),
                HOOK_TIMEOUT_MS,
              ).unref?.(),
            ),
          ])
          return toolSuccess({ moduleId, point, answer: answer ?? null })
        } catch (error) {
          return toolError('extension_hook_failed', error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'extension.dev.emit',
      description:
        'Send an extension’s open frames a push (`studio.on("push")`), as its worker’s `studio.emit` would: to ' +
        'test how a panel reacts without making the worker send it.',
      inputSchema: {
        type: 'object',
        properties: { ...target, topic: { type: 'string' }, payload: {} },
        required: ['topic'],
        additionalProperties: false,
      },
      mutates: true,
      handler: async (args, context) => {
        const remote = refusedRemote(context)
        if (remote) return remote
        const backend = deps.backend()
        const lifecycle = lifecycleOf(deps)
        if (isResult(lifecycle) || !backend)
          return isResult(lifecycle) ? lifecycle : toolError('unavailable', 'Not loaded yet.')
        const moduleId = await moduleIdOf(lifecycle, args)
        if (typeof moduleId !== 'string') return moduleId
        const topic = stringArg(args, 'topic', 200)
        if (!topic) return toolError('invalid_arguments', '"topic" is the push’s name.')
        backend.emit(moduleId, topic, args.payload)
        return toolSuccess({ moduleId, topic, delivered: true })
      },
    },
  ]
}
