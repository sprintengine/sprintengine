import type { StudioModuleEvent } from '../../../packages/studio-protocol/src/public'

// Module events: what a module's main half pushes to its own client half.
//
// A module's methods answer one request each; a module whose main half learns
// something its client half has to react to (a background run finishing, a
// watcher firing) emits it. The Studio carries every module's events on its
// `module.events` stream (packages/studio-protocol/src/modules.ts), and each
// window files them under the emitting module for that module's subscribers.
//
// Identity is stamped by the kernel from the emitting module's scope, exactly
// like notifications: a module can never emit as another, and a subscriber only
// ever receives its own module's events.
//
// ── Delivery contract ───────────────────────────────────────────────────────
//
// - **Fan-out.** One emit reaches every client following the stream. A module
//   with per-window state keys on it itself; the stream has no addressing.
// - **Ordering.** FIFO per emitting module: a `started` never lands after its `done`.
// - **No replay.** An event emitted while no client listens is dropped, and a
//   client that connects later sees nothing that happened before it. Events
//   are signals, not state: the durable answer must stay readable through the
//   module's own methods, and a subscriber must be correct having missed every
//   prior event. (Notifications differ: the server keeps its recent rows.)
// - **JSON.** A payload is a JSON value (objects, arrays, strings, finite
//   numbers, booleans, null): it crosses the Studio protocol. Anything else is
//   refused at `emit`, where the module hears why.
// - **Teardown.** `subscribe` returns its unsubscriber; call it on unmount.
//   Delivery is additionally gated on the owning module's live enablement, so
//   a subscription made before a disable stops receiving and resumes on
//   re-enable rather than outliving the toggle.
// - **No flood bound.** Unlike notifications — which are user-visible and
//   bounded against a misbehaving module — dropping an event would make a
//   subscriber wrong (a stale door, a run that never finishes). Emit rate is
//   the module's own responsibility.

export type ModuleEventEnvelope = StudioModuleEvent

/** Whether a value read off the stream is a module event: the kernel's stamp, then a topic. */
export function isModuleEvent(value: unknown): value is ModuleEventEnvelope {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<ModuleEventEnvelope>
  return (
    typeof event.sourceModuleId === 'string' && typeof event.topic === 'string' && typeof event.emittedAt === 'number'
  )
}

/**
 * Why a payload cannot cross the protocol, or null when it can: a JSON value
 * through and through. Read before the emit is delivered, so the module hears
 * it from its own `emit`. The SDK's test host applies the same check.
 */
export { jsonValueProblem as moduleEventPayloadProblem } from '../../../packages/module-sdk/src/json-value'

const MAX_TOPIC_LENGTH = 128

export type ModuleEmitValidation = { ok: true; topic: string } | { ok: false; message: string }

// Boundary validation for emit topics. Module code (third-party `entry.main`
// included) calls emit directly, so the input is untrusted. The payload is
// whatever the module and its own client half agreed on, held only to being
// JSON (`moduleEventPayloadProblem`).
export function validateModuleEventTopic(topic: unknown): ModuleEmitValidation {
  if (typeof topic !== 'string' || topic.trim().length === 0) {
    return { ok: false, message: 'emit(...) requires a non-empty topic.' }
  }
  const trimmed = topic.trim()
  if (trimmed.length > MAX_TOPIC_LENGTH) {
    return { ok: false, message: `emit(...) topic must be at most ${MAX_TOPIC_LENGTH} characters.` }
  }
  return { ok: true, topic: trimmed }
}
