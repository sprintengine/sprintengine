import { EXTENSION_HOST_SERVICES } from '../../../../packages/extension-sdk/src/services'
import type { ExtensionMcpToolContribution } from '../../../../packages/extension-sdk/src/extension-manifest'
import { isModuleMethodName, type ModuleMethodAccess } from '../../../shared/modules/methods'
import { HOST_CAPABILITIES } from '../../../shared/modules/host-api'
import type { ModuleFileDigests } from '../../../shared/modules/manifest'
import { isRecord, toolError, type McpToolRegistration, type McpToolResult } from '../../../shared/modules/mcp-tools'
import type { ModuleNotifyInput } from '../../../shared/modules/notifications'
import {
  settleMethodAnswer,
  type KernelWorkerPort,
  type MainHost,
  type MainKernel,
  type ModuleMethodCallOutcome,
  type ModuleMethodCallRequest,
} from '../../../main/module-host/main-host'
import { currentInvoker, ownerInvoker } from '../../../main/module-host/extension-invocation'
import { resolveContainedEntry } from '../../../main/modules/entry-containment'
import { moduleFileDigestIssuesSync } from '../../../main/modules/module-signature'
import { createWorkerLog, type WorkerLog } from './worker-log'
import { startWorkerProcess, WorkerCallError, type WorkerProcess } from './worker-process'
import {
  WORKER_CALL_TIMEOUT_MS,
  WORKER_IDLE_REAP_MS,
  WORKER_MAX_ACTIVE,
  WORKER_MAX_BACKGROUND,
  WORKER_MAX_RESTARTS,
  WORKER_READY_TIMEOUT_MS,
  WORKER_REAP_INTERVAL_MS,
  WORKER_RESTART_BACKOFF_MS,
  type WorkerError,
  type WorkerServiceShape,
} from './worker-protocol'
import { createWorkerSession, type WorkerSession } from './worker-session'
import { WorkerSlotPool, type WorkerSlot } from './worker-slots'

// Every worker extension of one Studio server, and its process.
//
// - Activation: an on-demand worker starts when something needs it (one of
//   its methods, an MCP tool, a command, a frame's `worker.request`, a
//   listener it handed Studio) and is stopped after five idle minutes; at most
//   five run at once, and one more waits for a place. A `background: true`
//   worker starts when it is switched on, is never reaped, and at most sixteen
//   run; the seventeenth waits, and Settings says why.
// - Supervision: a worker must say it is ready within ten seconds and answer
//   each call within thirty. One that crashes is started again after 500 ms,
//   2 s and 5 s; after the third restart a crash leaves it `errored`, in
//   Settings and as a bell row, until it is switched off and on.
// - Stopping: switching it off, uninstalling it or a change to the approval
//   it was started under stops it without a restart: two seconds for its
//   shutdown hooks, then it is killed. A call still in flight fails with
//   words that say why.
//
// Its MCP tools are advertised from its extension.json whether or not it runs,
// so an agent sees them before the first call starts it.

export type WorkerExtensionSpec = {
  extensionId: string
  displayName: string
  root: string
  /** Its `main`, relative to `root`. */
  main: string
  verifiedFiles: ModuleFileDigests
  background: boolean
  /** The approval it was loaded under. */
  fingerprint: string
  declaredTools: readonly ExtensionMcpToolContribution[]
}

/** An installed extension as discovery finds it: whether it may run as it is, and the approval it runs under. */
export type InstalledStanding = { runnable: boolean; fingerprint: string | null }

export type WorkerRunState = 'idle' | 'waiting' | 'starting' | 'running' | 'restarting' | 'errored' | 'stopped'

export type WorkerStatus = { state: WorkerRunState; message?: string; pid?: number }

export type ExtensionWorkersOptions = {
  /** The worker entry to fork (resolveWorkerEntryPath). */
  entryPath: string
  logDir: string
  /** The approvals as they stand now, by extension id. */
  approvals: () => ReadonlyMap<string, { fingerprint: string }>
  /**
   * The installed extensions as discovery finds them now, read when what is
   * installed may have changed: whether each may run as it is, and the
   * fingerprint it is approved under. Absent (tests), the approvals alone decide.
   */
  installed?: () => ReadonlyMap<string, InstalledStanding>
  gate: (moduleId: string, method: string) => { ok: true } | { ok: false; code: string; message: string }
  toolNameProblem: (moduleId: string, names: readonly string[]) => string | null
  /** A bell row under the extension's name (the kernel's emitNotification). */
  notify: (moduleId: string, input: ModuleNotifyInput) => void
  /** Its tools changed: tell the MCP clients. */
  toolsChanged?: () => void
  /** A worker's state changed: tell the windows. */
  stateChanged?: (moduleId: string) => void
  maxActive?: number
  maxBackground?: number
  idleReapMs?: number
  reapIntervalMs?: number
  readyTimeoutMs?: number
  callTimeoutMs?: number
  backoffMs?: readonly number[]
  maxRestarts?: number
  /** For tests: what runs the entry. */
  execPath?: string
}

type Entry = {
  spec: WorkerExtensionSpec
  host: MainHost
  log: WorkerLog
  state: WorkerRunState
  message?: string
  restarts: number
  /** Bumped by every stop: a start or restart from before it gives up. */
  generation: number
  starting: Promise<Entry> | null
  abort: AbortController | null
  process: WorkerProcess | null
  session: WorkerSession | null
  slot: WorkerSlot | null
  /** What its running process registered. */
  methods: Map<string, ModuleMethodAccess>
  tools: Set<string>
  /** The input schemas its tools last registered, advertised while it is not running. */
  schemas: Map<string, Record<string, unknown>>
  handlers: Map<string, McpToolRegistration['handler']>
}

/** The approval it was started under is gone or changed: stop, do not restart. */
class ApprovalChanged extends Error {}

const SERVICE_SHAPES: Record<string, WorkerServiceShape> = Object.fromEntries(
  EXTENSION_HOST_SERVICES.map((service) => [
    service.key,
    {
      methods: Object.keys(service.methods),
      returns: Object.fromEntries(
        Object.entries(service.returns ?? {}).map(([method, rows]) => [method, Object.keys(rows)]),
      ),
    },
  ]),
)

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('The worker was stopped while it waited to restart.'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * How the schema a worker registers takes more than the one extension.json
 * declares, or null when it matches or narrows it: an object; no parameter the
 * declaration leaves out when it allows no others; each parameter both name of
 * the same type; and every parameter the declaration requires required too.
 */
export function widerThanDeclared(
  registered: Record<string, unknown>,
  declared: Record<string, unknown>,
): string | null {
  if (registered.type !== 'object') return 'its schema does not describe an object.'
  const declaredProperties = isRecord(declared.properties) ? declared.properties : {}
  const registeredProperties = isRecord(registered.properties) ? registered.properties : {}
  if (declared.additionalProperties === false) {
    if (registered.additionalProperties !== false) return 'it does not refuse parameters extension.json leaves out.'
    const extra = Object.keys(registeredProperties).filter((key) => !Object.hasOwn(declaredProperties, key))
    if (extra.length > 0) return `it takes ${extra.map((key) => `"${key}"`).join(', ')}, which extension.json does not.`
  }
  for (const [key, schema] of Object.entries(registeredProperties)) {
    const mine = isRecord(schema) ? schema.type : undefined
    const theirs =
      Object.hasOwn(declaredProperties, key) && isRecord(declaredProperties[key])
        ? declaredProperties[key].type
        : undefined
    if (theirs !== undefined && JSON.stringify(mine) !== JSON.stringify(theirs))
      return `"${key}" is ${JSON.stringify(mine ?? 'any type')} there and ${JSON.stringify(theirs)} in extension.json.`
  }
  const required = new Set(Array.isArray(registered.required) ? registered.required : [])
  const dropped = (Array.isArray(declared.required) ? (declared.required as unknown[]) : []).filter(
    (key) => !required.has(key),
  )
  if (dropped.length > 0)
    return `it does not require ${dropped.map((key) => `"${String(key)}"`).join(', ')}, which extension.json does.`
  return null
}

export class ExtensionWorkers implements KernelWorkerPort {
  private readonly entries = new Map<string, Entry>()
  private readonly active: WorkerSlotPool
  private readonly backgroundPool: WorkerSlotPool
  private readonly reaper: NodeJS.Timeout
  private closed = false

  constructor(private readonly options: ExtensionWorkersOptions) {
    this.active = new WorkerSlotPool(options.maxActive ?? WORKER_MAX_ACTIVE)
    this.backgroundPool = new WorkerSlotPool(options.maxBackground ?? WORKER_MAX_BACKGROUND)
    this.reaper = setInterval(() => void this.reapIdle(), options.reapIntervalMs ?? WORKER_REAP_INTERVAL_MS)
    this.reaper.unref?.()
  }

  // ── The kernel's port ──────────────────────────────────────────────────────

  serves(moduleId: string): boolean {
    return this.entries.has(moduleId)
  }

  declaredMethods(moduleId: string): ReadonlyArray<{ name: string; access: ModuleMethodAccess }> {
    return [...(this.entries.get(moduleId)?.methods ?? [])].map(([name, access]) => ({ name, access }))
  }

  mcpTools(): ReadonlyArray<{ moduleId: string; registration: McpToolRegistration }> {
    const tools: Array<{ moduleId: string; registration: McpToolRegistration }> = []
    for (const entry of this.entries.values()) {
      // Stopped for good this run (removed, unapproved, changed): its tools leave the gateway.
      if (entry.state === 'stopped') continue
      for (const declared of entry.spec.declaredTools) {
        let handler = entry.handlers.get(declared.name)
        if (!handler)
          entry.handlers.set(declared.name, (handler = this.toolHandler(entry.spec.extensionId, declared.name)))
        tools.push({
          moduleId: entry.spec.extensionId,
          registration: {
            name: declared.name,
            description: declared.description,
            mutates: declared.access === 'operate',
            // extension.json's, so agents see the parameters before it has
            // ever run; else what its worker last registered.
            inputSchema: declared.inputSchema ?? entry.schemas.get(declared.name) ?? { type: 'object' },
            handler,
          },
        })
      }
    }
    return tools
  }

  async callMethod(request: ModuleMethodCallRequest): Promise<ModuleMethodCallOutcome> {
    let entry: Entry
    try {
      entry = await this.ensure(request.moduleId)
    } catch (error) {
      return { ok: false, code: 'extension_unavailable', message: messageOf(error) }
    }
    const access = entry.methods.get(request.method)
    if (!access)
      return {
        ok: false,
        code: 'extension_method_unknown',
        message: `Extension "${request.moduleId}" declares no method "${request.method}".`,
      }
    if (access !== request.access)
      return {
        ok: false,
        code: 'extension_method_unknown',
        message: `Extension "${request.moduleId}" declares "${request.method}" as ${access === 'operate' ? 'an operate' : 'a read'} method: call it with extension.${access}.`,
      }
    let answer: unknown
    try {
      answer = await entry.session!.run(
        {
          kind: 'method',
          name: request.method,
          params: request.params,
          context: {
            clientId: request.clientId,
            ...(request.commandId === undefined ? {} : { commandId: request.commandId }),
          },
        },
        request.invoker,
      )
    } catch (error) {
      if (error instanceof WorkerCallError && error.invalidParams)
        return {
          ok: false,
          code: 'invalid_params',
          message: error.message || `Extension "${request.moduleId}" refused the params of "${request.method}".`,
        }
      throw error
    }
    return settleMethodAnswer(request.moduleId, request.method, answer)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Hold an extension's worker for this load of it; a background one starts now. */
  attach(spec: WorkerExtensionSpec, host: MainHost): void {
    if (this.closed) throw new Error('Extension workers are shut down.')
    if (this.entries.has(spec.extensionId)) throw new Error(`Extension "${spec.extensionId}" is already loaded.`)
    // Its main is held to its folder before anything forks it.
    resolveContainedEntry(spec.root, spec.main, 'main')
    if (spec.verifiedFiles[spec.main] === undefined)
      throw new Error('main is not among the extension’s files that were verified.')
    const problem = this.options.toolNameProblem(
      spec.extensionId,
      spec.declaredTools.map((tool) => tool.name),
    )
    if (problem) throw new Error(problem)
    const entry: Entry = {
      spec,
      host,
      log: createWorkerLog(this.options.logDir, spec.extensionId),
      state: 'idle',
      restarts: 0,
      generation: 0,
      starting: null,
      abort: null,
      process: null,
      session: null,
      slot: null,
      methods: new Map(),
      tools: new Set(),
      schemas: new Map(),
      handlers: new Map(),
    }
    this.entries.set(spec.extensionId, entry)
    // Switching it off unloads it, and stops its worker without a restart.
    host.onShutdown(() => this.detach(spec.extensionId))
    if (spec.declaredTools.length > 0) this.options.toolsChanged?.()
    if (spec.background) void this.ensure(spec.extensionId).catch(() => undefined)
  }

  /** Let go of an extension: its worker stops, and its tools leave the gateway. */
  async detach(moduleId: string): Promise<void> {
    const entry = this.entries.get(moduleId)
    if (!entry) return
    await this.stop(entry, 'stopped', `Extension "${moduleId}" was switched off, so its worker stopped.`)
    this.entries.delete(moduleId)
    if (entry.spec.declaredTools.length > 0) this.options.toolsChanged?.()
  }

  status(moduleId: string): WorkerStatus | null {
    const entry = this.entries.get(moduleId)
    if (!entry) return null
    return {
      state: entry.state,
      ...(entry.message ? { message: entry.message } : {}),
      ...(entry.process?.pid === undefined ? {} : { pid: entry.process.pid }),
    }
  }

  /** Stop every worker whose approval is gone or changed since it was loaded. */
  reconcile(): void {
    const installed = this.options.installed?.()
    let toolsLeft = false
    for (const entry of this.entries.values()) {
      if (entry.state === 'stopped') continue
      const why = this.approvalProblem(entry) ?? (installed ? this.installProblem(entry, installed) : null)
      if (!why) continue
      void this.stop(entry, 'stopped', why)
      if (entry.spec.declaredTools.length > 0) toolsLeft = true
    }
    if (toolsLeft) this.options.toolsChanged?.()
  }

  /** Why the extension as installed now is not the one its worker was started as, or null. */
  private installProblem(entry: Entry, installed: ReadonlyMap<string, InstalledStanding>): string | null {
    const id = entry.spec.extensionId
    const standing = installed.get(id)
    if (!standing) return `Extension "${id}" is no longer installed, so its worker stopped.`
    if (!standing.runnable) return `Extension "${id}" changed and waits for your approval, so its worker stopped.`
    if (standing.fingerprint !== entry.spec.fingerprint)
      return `Extension "${id}" changed since its worker started, so the worker stopped. Restart Studio to run it as it is now.`
    return null
  }

  /** The running worker, started when it is not. */
  ensure(moduleId: string): Promise<Entry> {
    const entry = this.entries.get(moduleId)
    if (!entry || this.closed)
      return Promise.reject(
        new Error(
          `Extension "${moduleId}" is not running on this Studio: it is not installed, is switched off, or did not load.`,
        ),
      )
    if (entry.state === 'errored' || entry.state === 'stopped')
      return Promise.reject(new Error(entry.message ?? `Extension "${moduleId}"'s worker is stopped.`))
    if (entry.state === 'running' && entry.session) return Promise.resolve(entry)
    if (entry.starting) return entry.starting
    // A fresh start forgets earlier crashes; a restart keeps counting them.
    entry.restarts = 0
    return this.begin(entry)
  }

  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.reaper)
    this.active.close()
    this.backgroundPool.close()
    await Promise.all(
      [...this.entries.values()].map((entry) =>
        this.stop(entry, 'stopped', 'Studio is shutting down, so the worker stopped.'),
      ),
    )
  }

  /** Stop idle on-demand workers. */
  async reapIdle(now = Date.now()): Promise<void> {
    const idleMs = this.options.idleReapMs ?? WORKER_IDLE_REAP_MS
    await Promise.all(
      [...this.entries.values()]
        .filter(
          (entry) =>
            !entry.spec.background &&
            entry.state === 'running' &&
            entry.process !== null &&
            entry.process.inFlight() === 0 &&
            (entry.session?.live() ?? 0) === 0 &&
            now - entry.process.lastActivityAt() >= idleMs,
        )
        .map(async (entry) => {
          entry.log('[studio] stopping the worker: idle')
          await this.stop(entry, 'idle')
          entry.restarts = 0
        }),
    )
  }

  // ── Starting and stopping ──────────────────────────────────────────────────

  private setState(entry: Entry, state: WorkerRunState, message?: string): void {
    entry.state = state
    entry.message = message
    this.options.stateChanged?.(entry.spec.extensionId)
  }

  private approvalProblem(entry: Entry): string | null {
    const record = this.options.approvals().get(entry.spec.extensionId)
    if (!record)
      return `Extension "${entry.spec.extensionId}" is no longer approved (or was uninstalled), so its worker stopped.`
    if (record.fingerprint !== entry.spec.fingerprint)
      return `Extension "${entry.spec.extensionId}" changed since its worker started, so the worker stopped. Restart Studio to run it as it is now.`
    return null
  }

  /** Start (or, after `delayMs`, restart) its worker, through every restart its supervision allows. */
  private begin(entry: Entry, delayMs?: number): Promise<Entry> {
    const generation = entry.generation
    const controller = new AbortController()
    entry.abort = controller
    const starting = (async (): Promise<Entry> => {
      let delay = delayMs
      for (;;) {
        if (delay !== undefined) await sleep(delay, controller.signal)
        if (entry.generation !== generation) throw new Error(entry.message ?? 'The worker was stopped.')
        try {
          await this.attempt(entry, generation, controller.signal)
          return entry
        } catch (error) {
          if (entry.generation !== generation || controller.signal.aborted) throw error
          if (error instanceof ApprovalChanged) {
            await this.stop(entry, 'stopped', error.message)
            throw error
          }
          const next = this.recordFailure(entry, `it failed to start: ${messageOf(error)}`)
          if (next === null) throw new Error(entry.message)
          delay = next
        }
      }
    })()
    entry.starting = starting
    void starting.then(
      () => {
        if (entry.starting === starting) entry.starting = null
      },
      () => {
        if (entry.starting === starting) entry.starting = null
      },
    )
    return starting
  }

  /** One start: a place in its pool, its approval and files checked again, the fork, `ready`. */
  private async attempt(entry: Entry, generation: number, signal: AbortSignal): Promise<void> {
    const { spec } = entry
    const pool = spec.background ? this.backgroundPool : this.active
    if (!entry.slot) {
      if (!pool.hasRoom())
        this.setState(
          entry,
          'waiting',
          spec.background
            ? `Waiting to start: ${pool.capacity} extensions already run in the background, the most Studio runs at once. It starts when one of them is switched off.`
            : `Waiting to start: ${pool.capacity} extension workers are running, the most Studio runs at once. It starts when one of them stops.`,
        )
      entry.slot = await pool.acquire(signal)
    }
    const slot = entry.slot
    let session: WorkerSession | null = null
    try {
      const why = this.approvalProblem(entry)
      if (why) throw new ApprovalChanged(why)
      const changed = moduleFileDigestIssuesSync(spec.root, spec.verifiedFiles, {
        label: 'digests it was approved with',
      })
      if (changed.length > 0)
        throw new ApprovalChanged(
          `Extension "${spec.extensionId}"'s files changed after it was approved, so its worker was not started: ${changed
            .map((issue) => `${issue.path}: ${issue.message}`)
            .join('; ')}`,
        )
      this.setState(entry, entry.restarts > 0 ? 'restarting' : 'starting')
      entry.methods = new Map()
      entry.tools = new Set()
      let proc: WorkerProcess | null = null
      const created = createWorkerSession({
        extensionId: spec.extensionId,
        host: entry.host,
        background: spec.background,
        gate: (method) => this.options.gate(spec.extensionId, method),
        registerMethods: (batch) => this.registerMethods(entry, batch),
        registerMcpTools: (tools) => this.registerMcpTools(entry, tools),
        call: (call) =>
          proc
            ? proc.call(call, this.options.callTimeoutMs ?? WORKER_CALL_TIMEOUT_MS)
            : Promise.reject(new Error(`Extension "${spec.extensionId}"'s worker is not running.`)),
      })
      session = created
      const activation = created.startActivation()
      proc = await startWorkerProcess({
        extensionId: spec.extensionId,
        entryPath: this.options.entryPath,
        init: { ...this.initFor(entry), invocation: activation },
        log: (stream, line) => entry.log(`[${stream}] ${line}`),
        onHostCall: (message) => created.hostCall(message),
        onStarted: () => created.activationStarted(),
        // A listener it registers while it activates hears its first delivery then.
        onSpawn: (spawned) => {
          proc = spawned
        },
        readyTimeoutMs: this.options.readyTimeoutMs ?? WORKER_READY_TIMEOUT_MS,
        signal,
        ...(this.options.execPath ? { execPath: this.options.execPath } : {}),
      })
      if (entry.generation !== generation) {
        proc.kill()
        throw new Error(entry.message ?? 'The worker was stopped while it started.')
      }
      entry.process = proc
      entry.session = created
      const started = proc
      started.onExit((exit) => this.exited(entry, started, exit))
      entry.log(`[studio] worker started (pid ${proc.pid ?? 'unknown'})`)
      this.setState(entry, 'running')
    } catch (error) {
      session?.close()
      slot.release()
      if (entry.slot === slot) entry.slot = null
      entry.log(`[studio] worker did not start: ${messageOf(error)}`)
      throw error
    }
  }

  private initFor(entry: Entry) {
    const { spec, host } = entry
    const supports: Record<string, boolean> = {}
    for (const capability of [...HOST_CAPABILITIES, 'notifications']) supports[capability] = host.supports(capability)
    // Its code runs in a Node process of its own: never where Electron is.
    supports['electron-main'] = false
    let dataDir: { ok: true; path: string } | { ok: false; error: WorkerError }
    try {
      dataDir = { ok: true, path: host.getModuleDataDir() }
    } catch (error) {
      dataDir = {
        ok: false,
        error: {
          message: messageOf(error),
          name: (error as Error).name ?? 'Error',
          ...((error as { code?: string }).code ? { code: (error as { code: string }).code } : {}),
        },
      }
    }
    const provided = Object.keys(SERVICE_SHAPES).filter((key) => {
      try {
        return host.getService({ key }) !== undefined
      } catch {
        return false
      }
    })
    return {
      extensionId: spec.extensionId,
      entryPath: resolveContainedEntry(spec.root, spec.main, 'main'),
      root: spec.root,
      verifiedFiles: { ...spec.verifiedFiles },
      supports,
      dataDir,
      services: SERVICE_SHAPES,
      provided,
    }
  }

  private registerMethods(entry: Entry, batch: unknown): void {
    const id = entry.spec.extensionId
    if (batch === null || typeof batch !== 'object' || Array.isArray(batch))
      throw new Error(`Extension "${id}" declares its methods as an object of name to method.`)
    const entries = Object.entries(batch as Record<string, { access?: unknown } | null>)
    for (const [name, registration] of entries) {
      if (!isModuleMethodName(name))
        throw new Error(
          `Extension "${id}" method "${name}" is not a method name: a lower-case letter, then letters, digits, dots and dashes, at most 100.`,
        )
      if (entry.methods.has(name)) throw new Error(`Extension "${id}" already declares "${name}".`)
      const access = registration?.access
      if (access !== 'read' && access !== 'operate')
        throw new Error(`Extension "${id}" method "${name}" must say its access: "read" or "operate".`)
    }
    for (const [name, registration] of entries) entry.methods.set(name, registration!.access as ModuleMethodAccess)
  }

  private registerMcpTools(entry: Entry, tools: unknown): void {
    const id = entry.spec.extensionId
    if (!Array.isArray(tools)) throw new Error('registerMcpTools takes a list of tools.')
    const batch = new Map<string, Record<string, unknown>>()
    for (const tool of tools as Array<{ name?: unknown; inputSchema?: unknown }>) {
      const name = typeof tool?.name === 'string' ? tool.name : ''
      const declared = entry.spec.declaredTools.find((candidate) => candidate.name === name)
      if (!declared)
        throw new Error(
          `MCP tool "${name}" from extension "${id}" is not declared in its extension.json (contributes.mcpTools).`,
        )
      if (entry.tools.has(name) || batch.has(name))
        throw new Error(`MCP tool "${name}" is registered twice by extension "${id}".`)
      if (!isRecord(tool.inputSchema))
        throw new Error(`MCP tool "${name}" from extension "${id}" has no inputSchema object.`)
      const wider = declared.inputSchema ? widerThanDeclared(tool.inputSchema, declared.inputSchema) : null
      if (wider)
        throw new Error(`MCP tool "${name}" from extension "${id}" takes more than its extension.json says: ${wider}`)
      batch.set(name, tool.inputSchema)
    }
    let changed = false
    for (const [name, schema] of batch) {
      entry.tools.add(name)
      if (JSON.stringify(entry.schemas.get(name)) !== JSON.stringify(schema)) changed = true
      entry.schemas.set(name, schema)
    }
    if (changed) this.options.toolsChanged?.()
  }

  private toolHandler(moduleId: string, name: string): McpToolRegistration['handler'] {
    return async (args, context) => {
      let entry: Entry
      try {
        entry = await this.ensure(moduleId)
      } catch (error) {
        return toolError('extension_unavailable', messageOf(error))
      }
      if (!entry.tools.has(name))
        return toolError('tool_unavailable', `Extension "${moduleId}"'s worker did not register the tool "${name}".`)
      try {
        const result = (await entry.session!.run(
          { kind: 'tool', name, args: args ?? {}, context: (context ?? {}) as Record<string, unknown> },
          currentInvoker(),
        )) as McpToolResult
        if (!isRecord(result) || !Array.isArray(result.content))
          return toolError(
            'tool_failed',
            `Extension "${moduleId}"'s tool "${name}" answered something that is not a tool result.`,
          )
        return result
      } catch (error) {
        return toolError(error instanceof WorkerCallError && error.code ? error.code : 'tool_failed', messageOf(error))
      }
    }
  }

  /** A failure counted against its restarts: the wait before the next start, or null once it is errored. */
  private recordFailure(entry: Entry, what: string): number | null {
    const maxRestarts = this.options.maxRestarts ?? WORKER_MAX_RESTARTS
    const backoff = this.options.backoffMs ?? WORKER_RESTART_BACKOFF_MS
    const id = entry.spec.extensionId
    if (entry.restarts >= maxRestarts) {
      const message = `Extension "${id}"'s worker stopped after it crashed ${entry.restarts + 1} times; ${what}. Switch it off and on again to try once more.`
      entry.log(`[studio] ${message}`)
      this.setState(entry, 'errored', message)
      this.options.notify(id, { severity: 'error', title: `${entry.spec.displayName} stopped working`, body: message })
      return null
    }
    const delay = backoff[Math.min(entry.restarts, backoff.length - 1)]!
    entry.restarts += 1
    entry.log(`[studio] ${what}; restart ${entry.restarts} in ${delay}ms`)
    this.setState(entry, 'restarting', `Restarting after a crash (${entry.restarts} of ${maxRestarts}).`)
    return delay
  }

  private exited(
    entry: Entry,
    proc: WorkerProcess,
    exit: { code: number | null; signal: NodeJS.Signals | null; requested: boolean },
  ): void {
    if (entry.process !== proc) return
    entry.process = null
    entry.session?.close()
    entry.session = null
    entry.slot?.release()
    entry.slot = null
    if (exit.requested) return
    const next = this.recordFailure(entry, `it exited unexpectedly (${exit.signal ?? `code ${exit.code}`})`)
    if (next !== null) void this.begin(entry, next).catch(() => undefined)
  }

  /** Stop its worker, with no restart, and leave it in `state`. */
  private async stop(entry: Entry, state: 'idle' | 'stopped', message?: string): Promise<void> {
    entry.generation += 1
    entry.abort?.abort()
    entry.abort = null
    const proc = entry.process
    const session = entry.session
    entry.process = null
    entry.session = null
    this.setState(entry, state, message)
    if (proc && session) {
      const shutdown = session.begin(ownerInvoker(null, 'Studio, stopping it'))
      await proc.stop(
        shutdown,
        message ?? `Extension "${entry.spec.extensionId}"'s worker was stopped before it answered.`,
      )
      entry.log(`[studio] worker stopped${message ? `: ${message}` : ''}`)
    }
    session?.close()
    entry.slot?.release()
    entry.slot = null
  }
}

/**
 * A server's workers, bound to its module kernel once the kernel exists: the
 * kernel's gate judges their host calls, its bell rings for them, and it asks
 * them for their extensions' methods and tools.
 */
export function createExtensionWorkers(options: Omit<ExtensionWorkersOptions, 'gate' | 'toolNameProblem' | 'notify'>): {
  workers: ExtensionWorkers
  bind(kernel: MainKernel): void
} {
  let kernel: MainKernel | null = null
  const bound = (): MainKernel => {
    if (!kernel) throw new Error('Extension workers are used before the module kernel exists.')
    return kernel
  }
  const workers = new ExtensionWorkers({
    ...options,
    gate: (moduleId, method) => bound().gateHostMethod(moduleId, method),
    toolNameProblem: (moduleId, names) => bound().mcpToolNameProblem(moduleId, names),
    notify: (moduleId, input) => bound().emitNotification(moduleId, input),
  })
  return {
    workers,
    bind(next) {
      kernel = next
      next.attachWorkers(workers)
    },
  }
}
