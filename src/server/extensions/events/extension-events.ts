import {
  EXTENSION_EVENT_SPECS,
  EXTENSION_EVENTS,
  type ExtensionEventName,
  type ExtensionEventPayloads,
} from '../../../../packages/extension-sdk/src/events'
import { EXTENSION_HOST_REFUSALS } from '../../../../packages/extension-sdk/src/services'
import { gateExtensionHostCall, type ExtensionHostDecision } from '../../../main/module-host/extension-host-gate'
import type { ExtensionInvoker } from '../../../main/module-host/extension-invocation'

// Studio's events, as its extensions hear them (the events themselves, and
// what each needs, are packages/extension-sdk/src/events.ts).
//
// A Studio holds one of these. Its sources (studio-events.ts) ask `wants`
// first, so an event nobody listens for costs nothing, then `emit` it once.
// It goes to two kinds of listener:
//
// - the extensions' workers (worker-manager.ts `deliverEvent`), each of which
//   lists the events it hears and is checked there against its approval as it
//   stands;
// - the surfaces' frames, through each connection that follows
//   `extension.studioEvents` for one extension and one event
//   (studio-rpc-connection.ts): `admit` holds it to the extension's approval
//   and to that connection's grant, at the subscription and again at each
//   event, so an approval or a grant narrowed meanwhile stops it at once.

/** What the extensions' workers offer (worker-manager.ts). */
export type ExtensionEventSink = {
  eventsListed(event: ExtensionEventName): boolean
  deliverEvent(event: ExtensionEventName, payload: unknown): void
  /** The permissions an extension's approval holds now; null when it is not approved as it is. */
  grantOf(moduleId: string): readonly string[] | null
}

export type ExtensionEvents = {
  /** Whether anything listens for `event`: a worker that lists it, or a frame. Synchronous. */
  wants(event: ExtensionEventName): boolean
  /** Tell every listener. The payload is copied for each. */
  emit<E extends ExtensionEventName>(event: E, payload: ExtensionEventPayloads[E]): void
  /** Hear `event` (a connection, for its frames); returns the unsubscriber. */
  listen<E extends ExtensionEventName>(event: E, listener: (payload: ExtensionEventPayloads[E]) => void): () => void
  /** Whether extension `moduleId`'s frame opened by `invoker` may hear `event` now. */
  admit(moduleId: string, event: ExtensionEventName, invoker: ExtensionInvoker): ExtensionHostDecision
  /** The workers to tell; null (as at first, and in a Studio with no extensions) tells none. */
  bind(sink: ExtensionEventSink | null): void
}

export function createExtensionEvents(options: { log?: (line: string) => void } = {}): ExtensionEvents {
  let sink: ExtensionEventSink | null = null
  const listeners = new Map<ExtensionEventName, Set<(payload: unknown) => void>>(
    EXTENSION_EVENTS.map((event) => [event, new Set()]),
  )
  return {
    wants: (event) => listeners.get(event)!.size > 0 || sink?.eventsListed(event) === true,
    emit(event, payload) {
      if (sink?.eventsListed(event)) {
        try {
          sink.deliverEvent(event, payload)
        } catch (error) {
          options.log?.(
            `event ${event} could not reach the workers: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      for (const listener of [...listeners.get(event)!]) {
        try {
          listener(structuredClone(payload))
        } catch (error) {
          options.log?.(
            `event ${event} could not reach a client: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    },
    listen(event, listener) {
      const set = listeners.get(event)!
      const heard = listener as (payload: unknown) => void
      set.add(heard)
      return () => {
        set.delete(heard)
      }
    },
    admit(moduleId, event, invoker) {
      const spec = EXTENSION_EVENT_SPECS[event]
      const grant = sink ? sink.grantOf(moduleId) : null
      if (!sink)
        return {
          ok: false,
          code: EXTENSION_HOST_REFUSALS.approvalRequired,
          message: `Extension "${moduleId}" is not running on this Studio: its extensions have not loaded.`,
        }
      return gateExtensionHostCall({
        extensionId: moduleId,
        method: `the event ${event}`,
        requirement: { extension: spec.permission, invoker: spec.invoker, refusal: 'answer' },
        grant,
        invoker,
      })
    },
    bind(next) {
      sink = next
    },
  }
}
