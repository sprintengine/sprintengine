import {
  EXTENSION_HOOK_SPECS,
  EXTENSION_HOOK_TIME_LIMIT_MS,
  readExtensionHookAnswer,
  type ExtensionHookEvents,
  type ExtensionHookPoint,
} from '../../../../packages/extension-sdk/src/hooks'
import type { ExtensionInvoker } from '../../../main/module-host/extension-invocation'
import { WORKER_READY_TIMEOUT_MS } from '../workers/worker-protocol'
import type { WorkerHookParticipant } from '../workers/worker-manager'

// Where Studio's own code meets extensions' hooks (the points, and what a hook
// may answer, are packages/extension-sdk/src/hooks.ts).
//
// A Studio holds one of these. Its call sites ask `wants(point)` first, which
// is synchronous and reads the loaded extensions' manifests only, so a point no
// extension lists costs one map walk and no await. Then `run` walks the
// extensions that list it, in the order of their install keys, each in its own
// worker and as the invoker of the action it guards (the chat's owner, the
// paired device that started it, the agent): a hook's calls into Studio pass
// the host's gate as that invoker, so a hook can do no more than whoever set
// the action off. A worker that is not running is started first, and its start
// is not counted against the hook's two seconds.
//
// A hook that throws, answers late, answers nonsense, or whose worker crashed
// or did not start, passes, unless its extension listed the point with
// `onError: "deny"`: then the action is refused, naming the extension. An
// extension switched off, removed or changed while its hook ran no longer
// speaks for the person, and passes either way. So a broken or slow extension
// delays an action by at most its time limit (and its start), and never hangs it.
//
// Hooks run where the action runs: in the Studio server that holds the chat,
// terminal, workspace or file. A paired client's request is decided by the
// extensions installed on the Studio it reached.

/** What the extensions' workers offer the chain (worker-manager.ts). */
export type ExtensionHookSource = {
  hooksListed(point: ExtensionHookPoint): boolean
  hookParticipants(point: ExtensionHookPoint): WorkerHookParticipant[]
  startForHook(extensionId: string): Promise<void>
  runHook(
    extensionId: string,
    point: ExtensionHookPoint,
    event: unknown,
    invoker: ExtensionInvoker,
    timeoutMs: number,
  ): Promise<unknown>
  stillServes(extensionId: string, fingerprint: string): boolean
  /** A line in the extension's own log. */
  logHook?(extensionId: string, line: string): void
}

/** What the chain decided: go on with `event` (as changed), or an extension refused. */
export type ExtensionHookOutcome<E> =
  | { kind: 'continue'; event: E }
  | {
      kind: 'deny'
      extensionId: string
      displayName: string
      reason: string
      /** It refused because its hook failed and it fails closed, not because the hook said no. */
      failed: boolean
    }

/** An action an extension's hook refused; the message names the extension and its reason. */
export class ExtensionHookDenied extends Error {
  readonly code = 'refused_by_extension'
  constructor(
    readonly point: ExtensionHookPoint,
    readonly extensionId: string,
    readonly displayName: string,
    readonly reason: string,
  ) {
    super(extensionHookRefusal({ displayName, extensionId, reason }))
    this.name = 'ExtensionHookDenied'
  }
}

/** The words a refusal is shown in, to the person and to the agent. */
export function extensionHookRefusal(denied: { displayName: string; extensionId: string; reason: string }): string {
  return `The extension "${denied.displayName}" (${denied.extensionId}) refused this: ${denied.reason}`
}

export type ExtensionHooks = {
  /** Whether any extension listed `point`. Synchronous: the no-hook path awaits nothing. */
  wants(point: ExtensionHookPoint): boolean
  /**
   * Run a `before` point's chain. Never rejects. `budgetMs` caps the whole
   * chain (a tool decision's six seconds): once spent, each extension not yet
   * asked is decided by its `onError`.
   */
  run<P extends ExtensionHookPoint>(
    point: P,
    event: ExtensionHookEvents[P],
    invoker: ExtensionInvoker,
    options?: { budgetMs?: number },
  ): Promise<ExtensionHookOutcome<ExtensionHookEvents[P]>>
  /** Tell an `after` point's hooks, without waiting for them. */
  notify<P extends ExtensionHookPoint>(point: P, event: ExtensionHookEvents[P], invoker: ExtensionInvoker): void
  /** The workers to ask; null (as at first, and in a Studio with no extensions) runs no hooks. */
  bind(source: ExtensionHookSource | null): void
}

export type ExtensionHooksOptions = {
  /** One line for the extension's log: which hook, how long, what happened. */
  log?: (extensionId: string, line: string) => void
  now?: () => number
  /** For tests. */
  timeLimitMs?: number
  startTimeoutMs?: number
}

function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} within ${ms / 1000}s`)), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function createExtensionHooks(options: ExtensionHooksOptions = {}): ExtensionHooks {
  let source: ExtensionHookSource | null = null
  const now = options.now ?? (() => performance.now())
  const log = (extensionId: string, line: string): void => {
    if (source?.logHook) source.logHook(extensionId, line)
    else options.log?.(extensionId, line)
  }
  const timeLimitMs = options.timeLimitMs ?? EXTENSION_HOOK_TIME_LIMIT_MS
  const startTimeoutMs = options.startTimeoutMs ?? WORKER_READY_TIMEOUT_MS

  async function runChain<P extends ExtensionHookPoint>(
    point: P,
    event: ExtensionHookEvents[P],
    invoker: ExtensionInvoker,
    budgetMs: number | undefined,
    participants: readonly WorkerHookParticipant[],
  ): Promise<ExtensionHookOutcome<ExtensionHookEvents[P]>> {
    const workers = source
    if (!workers) return { kind: 'continue', event }
    const decides = EXTENSION_HOOK_SPECS[point].decides
    const deadline = budgetMs === undefined ? Infinity : now() + budgetMs
    let current = event as Record<string, unknown>
    for (const participant of participants) {
      const { extensionId, displayName } = participant
      const startedAt = now()
      const elapsed = () => Math.round(now() - startedAt)
      const failClosed = decides && participant.onError === 'deny'
      const failed = (problem: string): ExtensionHookOutcome<ExtensionHookEvents[P]> | null => {
        // One switched off, removed or changed no longer speaks for the person,
        // whether its hook answered or failed: it passes, whatever its onError.
        if (!workers.stillServes(extensionId, participant.fingerprint)) {
          log(extensionId, `hook ${point} passed after ${elapsed()}ms: it was switched off or changed (${problem})`)
          return null
        }
        if (failClosed) {
          log(extensionId, `hook ${point} refused after ${elapsed()}ms (onError: deny): ${problem}`)
          return {
            kind: 'deny',
            extensionId,
            displayName,
            reason: `its hook failed, and it refuses when it fails: ${problem}`,
            failed: true,
          }
        }
        log(extensionId, `hook ${point} passed after ${elapsed()}ms because it failed: ${problem}`)
        return null
      }
      const left = deadline - now()
      if (left <= 0) {
        // The action's whole time is spent: each one not yet asked is decided by its onError.
        const outcome = failed(`the ${budgetMs! / 1000}s this action waits on all its hooks ran out first`)
        if (outcome) return outcome
        continue
      }
      let answer: unknown
      try {
        // Its start is the worker's own wait (the supervisor's ready limit), not the hook's.
        await within(workers.startForHook(extensionId), Math.min(startTimeoutMs, left), 'its worker did not start')
        const limit = Math.min(timeLimitMs, Math.max(1, deadline - now()))
        const hookStartedAt = now()
        answer = await within(
          workers.runHook(extensionId, point, structuredClone(current), invoker, limit),
          // A margin over the worker's own limit, so the worker's timeout is the one heard.
          limit + 50,
          'it did not answer',
        )
        if (!workers.stillServes(extensionId, participant.fingerprint)) throw new Error('it answered after it left')
        log(extensionId, `hook ${point} answered in ${Math.round(now() - hookStartedAt)}ms`)
      } catch (error) {
        const outcome = failed(messageOf(error))
        if (outcome) return outcome
        continue
      }
      const verdict = readExtensionHookAnswer(point, current, answer)
      switch (verdict.kind) {
        case 'pass':
          continue
        case 'ignored':
          log(extensionId, `hook ${point}: ${verdict.problem}`)
          continue
        case 'invalid': {
          const outcome = failed(`it answered something a hook cannot: ${verdict.problem}`)
          if (outcome) return outcome
          continue
        }
        case 'change':
          log(extensionId, `hook ${point} changed ${verdict.changed.join(', ')}`)
          current = verdict.event
          continue
        case 'deny':
          log(extensionId, `hook ${point} refused: ${verdict.reason}`)
          return { kind: 'deny', extensionId, displayName, reason: verdict.reason, failed: false }
      }
    }
    return { kind: 'continue', event: current as ExtensionHookEvents[P] }
  }

  function run<P extends ExtensionHookPoint>(
    point: P,
    event: ExtensionHookEvents[P],
    invoker: ExtensionInvoker,
    options: { budgetMs?: number } = {},
  ): Promise<ExtensionHookOutcome<ExtensionHookEvents[P]>> {
    let participants: WorkerHookParticipant[] = []
    try {
      participants = source?.hookParticipants(point) ?? []
    } catch (error) {
      log('studio', `hook ${point}: its extensions could not be listed: ${messageOf(error)}`)
    }
    return runChain(point, event, invoker, options.budgetMs, participants).catch((error: unknown) => {
      // Should the chain itself throw, a guard that refuses when it fails still does.
      log('studio', `hook ${point} chain failed: ${messageOf(error)}`)
      const closed = EXTENSION_HOOK_SPECS[point].decides
        ? participants.find((participant) => participant.onError === 'deny')
        : undefined
      return closed
        ? {
            kind: 'deny' as const,
            extensionId: closed.extensionId,
            displayName: closed.displayName,
            reason: `its hook could not be run, and it refuses when it fails: ${messageOf(error)}`,
            failed: true,
          }
        : { kind: 'continue' as const, event }
    })
  }

  return {
    wants: (point) => source?.hooksListed(point) === true,
    run,
    notify: (point, event, invoker) => {
      if (source?.hooksListed(point)) void run(point, event, invoker).catch(() => undefined)
    },
    bind(next) {
      source = next
    },
  }
}

/**
 * The decision a person's save of text meets, from whichever editor made it
 * (Studio's text editor over `files.writeText`, an extension's custom text
 * editor over a frame's `files.write`): null at once when no extension hooks
 * `editor.save.before`, else the text to write or a refusal naming the
 * extension that refused.
 */
export function editorSaveDecision(
  hooks: ExtensionHooks | null | undefined,
  event: ExtensionHookEvents['editor.save.before'],
  invoker: ExtensionInvoker,
): Promise<{ ok: true; text: string } | { ok: false; message: string }> | null {
  if (!hooks?.wants('editor.save.before')) return null
  return hooks
    .run('editor.save.before', event, invoker)
    .then((outcome) =>
      outcome.kind === 'deny'
        ? { ok: false as const, message: extensionHookRefusal(outcome) }
        : { ok: true as const, text: outcome.event.text },
    )
}

/**
 * Run a `before` point and hand back the event to act on, or throw
 * `ExtensionHookDenied`. With no hooks listed it answers the event as given,
 * without awaiting anything but itself.
 */
export async function runExtensionHook<P extends ExtensionHookPoint>(
  hooks: ExtensionHooks | null | undefined,
  point: P,
  event: ExtensionHookEvents[P],
  invoker: () => ExtensionInvoker,
): Promise<ExtensionHookEvents[P]> {
  if (!hooks?.wants(point)) return event
  const outcome = await hooks.run(point, event, invoker())
  if (outcome.kind === 'deny')
    throw new ExtensionHookDenied(point, outcome.extensionId, outcome.displayName, outcome.reason)
  return outcome.event
}
