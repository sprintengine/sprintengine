import {
  STUDIO_PROTOCOL_MIN_SUPPORTED,
  STUDIO_PROTOCOL_VERSION,
  STUDIO_UPDATE_SESSION_CAPABILITY,
  createStudioChunkAssembler,
  isKnownStudioServerFrameType,
  parseStudioServerFrame,
  parseStudioUpdateStatus,
  studioCompatibility,
  type StudioAuth,
  type StudioClientKind,
  type StudioCompatibility,
  type StudioIncompatibleFrame,
  type StudioParsedServerFrame,
  type StudioUpdateMethodMap,
  type StudioUpdateStatus,
  type StudioWelcomeFrame,
} from '../protocol.js'
import { StudioError, byeError } from './errors.js'
import type { StudioTransportFactory } from './transport.js'

// Reaching a Studio to see how it stands and update it, whatever protocol it
// speaks.
//
// `connect` refuses a Studio whose protocol window does not meet this
// client's (`unsupported_protocol_version`), and should: nothing it sends
// would be understood. This opens one connection that asks to be kept anyway
// (`update-session`), and calls only the update methods, whose shapes never
// change. A compatible Studio is welcomed as usual, and serves the same two
// methods.

export type StudioUpdateSessionOptions = {
  transport: StudioTransportFactory
  client: { name: string; version?: string; kind?: StudioClientKind }
  /** A token: a pairing code is never spent on a connection kept only for updates. */
  auth?: { token: string }
  helloTimeoutMs?: number
  requestTimeoutMs?: number
}

export type StudioUpdateSession = {
  /** How this client stands with the Studio: never `unknown` once open. */
  compatibility: Exclude<StudioCompatibility, 'unknown'>
  /** The welcome, from a Studio this client can talk to. */
  welcome: StudioWelcomeFrame | null
  /** Why not, and who the Studio is, from one it cannot. */
  incompatible: StudioIncompatibleFrame | null
  /** Where an update stands: how the Studio is updated, and what a person does when it cannot update itself. */
  status(): Promise<StudioUpdateStatus>
  /**
   * Ask a Studio that updates itself to update: refused `update_unavailable`
   * (with the words to do it by hand) by one that does not, and
   * `scope_required` without `environment:maintain`. The restart that follows
   * closes this session.
   */
  start(params?: {
    commandId?: string
    targetVersion?: string
  }): Promise<StudioUpdateMethodMap['update.start']['result']>
  close(): void
}

const DEFAULT_HELLO_TIMEOUT_MS = 15_000
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

/**
 * Open a connection for the update methods alone. Rejects with a `StudioError`
 * when Studio closes it: `unauthorized` for a credential it refuses, and
 * `unsupported_protocol_version` from a Studio built before it kept such
 * connections, whose words say which end to update.
 */
export async function openStudioUpdateSession(options: StudioUpdateSessionOptions): Promise<StudioUpdateSession> {
  const transport = await options.transport()
  const credential: StudioAuth | undefined = transport.credential ?? options.auth
  if (!credential || !('token' in credential)) {
    transport.close()
    throw new StudioError('unauthorized', 'An update session needs a token: pair the app first.')
  }
  const assembler = createStudioChunkAssembler()
  const pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: StudioError): void; timer: ReturnType<typeof setTimeout> }
  >()
  let sequence = 0
  let closedWith: StudioError | null = null
  let greet: ((frame: StudioWelcomeFrame | StudioIncompatibleFrame) => void) | null = null
  let refuse: ((error: StudioError) => void) | null = null
  const greeting = new Promise<StudioWelcomeFrame | StudioIncompatibleFrame>((resolve, reject) => {
    greet = resolve
    refuse = reject
  })
  const failAll = (error: StudioError) => {
    closedWith = error
    refuse?.(error)
    for (const [id, waiter] of pending) {
      clearTimeout(waiter.timer)
      pending.delete(id)
      waiter.reject(error)
    }
  }
  const route = (frame: StudioParsedServerFrame): void => {
    switch (frame.t) {
      case 'welcome':
      case 'incompatible':
        greet?.(frame)
        return
      case 'bye':
        failAll(byeError(frame))
        return
      case 'chunk': {
        const step = assembler.push(frame)
        if (step.kind === 'frame') receive(step.json)
        else if (step.kind === 'error') transport.close()
        return
      }
      case 'res': {
        const waiter = pending.get(frame.id)
        if (!waiter) return
        pending.delete(frame.id)
        clearTimeout(waiter.timer)
        if (frame.ok) waiter.resolve(frame.result)
        else
          waiter.reject(
            new StudioError(frame.error.code, frame.error.message, frame.error.retryAfterMs, frame.error.errorId),
          )
        return
      }
      default:
        // Nothing else is sent to a session that subscribes to nothing and offers no tools.
        return
    }
  }
  const receive = (text: string): void => {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      transport.close()
      return
    }
    const frame = parseStudioServerFrame(value)
    if (frame) route(frame)
    // A greeting this client cannot read is said at once, not left to the hello's deadline.
    else if (isKnownStudioServerFrameType(value) && ['welcome', 'incompatible'].includes((value as { t: string }).t))
      failAll(new StudioError('invalid_frame', 'Studio answered the hello in a shape this client cannot read.'))
  }
  transport.onMessage(receive)
  transport.onClose((error) =>
    failAll(closedWith ?? new StudioError('disconnected', error?.message ?? 'The connection closed.')),
  )
  const timer = setTimeout(
    () => refuse?.(new StudioError('hello_timeout', 'Studio did not answer the hello in time.')),
    options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS,
  )
  transport.send(
    JSON.stringify({
      t: 'hello',
      protocolVersion: STUDIO_PROTOCOL_VERSION,
      minProtocolVersion: STUDIO_PROTOCOL_MIN_SUPPORTED,
      client: { ...options.client, capabilities: [STUDIO_UPDATE_SESSION_CAPABILITY] },
      auth: credential,
    }),
  )
  let greeted: StudioWelcomeFrame | StudioIncompatibleFrame
  try {
    greeted = await greeting
  } catch (error) {
    transport.close()
    throw error
  } finally {
    clearTimeout(timer)
  }

  const ask = (method: keyof StudioUpdateMethodMap, params: object): Promise<unknown> => {
    if (closedWith) return Promise.reject(closedWith)
    const id = `u${++sequence}`
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id)
        reject(new StudioError('timeout', `Studio did not answer ${method} in time.`))
      }, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer: timeout })
      transport.send(JSON.stringify({ t: 'req', id, method, params }))
    })
  }
  const window = { protocolVersion: greeted.protocolVersion, minProtocolVersion: greeted.minProtocolVersion }
  const judged = studioCompatibility(window)
  return {
    compatibility: greeted.t === 'incompatible' ? greeted.compatibility : judged === 'unknown' ? 'compatible' : judged,
    welcome: greeted.t === 'welcome' ? greeted : null,
    incompatible: greeted.t === 'incompatible' ? greeted : null,
    async status() {
      const status = parseStudioUpdateStatus(await ask('update.status', {}))
      if (!status)
        throw new StudioError('invalid_frame', 'Studio answered update.status in a shape this client cannot read.')
      return status
    },
    async start(params = {}) {
      // Names this request for the audit; another request under the same id is
      // refused. Asking again is harmless: a Studio already updating accepts again.
      const commandId =
        params.commandId ?? `update-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      const result = (await ask('update.start', { ...params, commandId })) as Record<string, unknown> | null
      return {
        accepted: true,
        method: 'self',
        targetVersion: typeof result?.targetVersion === 'string' ? result.targetVersion : null,
      }
    },
    close: () => transport.close(),
  }
}
