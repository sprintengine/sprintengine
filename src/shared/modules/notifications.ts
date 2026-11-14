// Module notifications — the shared payload contract for the module kernel's
// bell rows.
//
// A notification is a small, typed, status payload emitted by a capability
// module through its scoped host (`host.notify(...)`). The source module id is
// stamped by the host from its own scope — it is never accepted from the
// caller, so one module cannot impersonate another.
//
// ── Delivery ────────────────────────────────────────────────────────────────
//
// A notification that passes the kernel's flood bound is a bell row. The kernel
// stamps an id and the module's display name onto it and delivers it on the
// Studio's `module.notifications` stream (packages/studio-protocol/src/modules.ts)
// to every client following it. The renderer files it into its notification store.
//
// Unlike module events, the kernel also keeps the recent ones: a module's
// launch failure or an `onStartup` notify lands before any window has
// subscribed, so the stream sends the kept rows first to each new subscriber.
// The id is what keeps a row heard twice (after a reconnect) from being filed twice.

import type {
  StudioModuleNotification,
  StudioModuleNotificationSeverity,
  StudioModuleNotificationTarget,
} from '../../../packages/studio-protocol/src/public'
import { sliceWhole } from '../slice-whole'

export type ModuleNotificationSeverity = StudioModuleNotificationSeverity

const SEVERITIES: readonly ModuleNotificationSeverity[] = ['info', 'warning', 'error']

/**
 * The door a bell row opens: one of the emitting module's own global surfaces,
 * and optionally the view to land it on. The renderer refuses a surface another
 * module registered, so a row can only ever open its own module's door.
 */
export type ModuleNotificationTarget = StudioModuleNotificationTarget

/** A bell row as a module raised it, before the kernel stamps its delivery id and the module's name. */
export type ModuleNotification = Omit<StudioModuleNotification, 'id' | 'sourceModuleName'>

/** What a module passes to `host.notify(...)`; identity and time are stamped by the kernel. */
export type ModuleNotifyInput = {
  severity: ModuleNotificationSeverity
  title: string
  body?: string
  /**
   * Open one of your own global surfaces (and optionally a view of it) when
   * the person clicks the row. A surface another module registered is refused
   * at click time, and the row keeps only its Copy action.
   */
  target?: ModuleNotificationTarget
}

/**
 * One delivered bell row, as the kernel publishes it: the notification plus
 * the identity the renderer files it under. App-internal (the published SDK
 * carries `ModuleNotification`); `id` is unique per kernel, so a window that
 * reads the recent backlog after hearing a live delivery files it once.
 */
export type ModuleNotificationDelivery = StudioModuleNotification

const MAX_TITLE_LENGTH = 200
const MAX_BODY_LENGTH = 2000
const MAX_TARGET_ID_LENGTH = 200

export type ModuleNotifyValidation =
  | {
      ok: true
      severity: ModuleNotificationSeverity
      title: string
      body?: string
      target?: ModuleNotificationTarget
    }
  | { ok: false; message: string }

function validateTargetId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= MAX_TARGET_ID_LENGTH ? trimmed : null
}

// Boundary validation for notify payloads. Module code (including third-party
// entry.main code) calls notify directly, so the input is untrusted.
export function validateModuleNotifyInput(input: unknown): ModuleNotifyValidation {
  if (!input || typeof input !== 'object') {
    return { ok: false, message: 'notify(...) requires a payload object.' }
  }
  const { severity, title, body, target } = input as Record<string, unknown>
  if (typeof severity !== 'string' || !SEVERITIES.includes(severity as ModuleNotificationSeverity)) {
    return { ok: false, message: 'notify(...) severity must be "info", "warning", or "error".' }
  }
  if (typeof title !== 'string' || title.trim().length === 0) {
    return { ok: false, message: 'notify(...) requires a non-empty title.' }
  }
  if (body !== undefined && typeof body !== 'string') {
    return { ok: false, message: 'notify(...) body must be a string when provided.' }
  }
  let validatedTarget: ModuleNotificationTarget | undefined
  if (target !== undefined) {
    if (!target || typeof target !== 'object') {
      return { ok: false, message: 'notify(...) target must be { surfaceId, viewId? } when provided.' }
    }
    const { surfaceId, viewId } = target as Record<string, unknown>
    const validSurfaceId = validateTargetId(surfaceId)
    if (!validSurfaceId) {
      return { ok: false, message: 'notify(...) target.surfaceId must be a non-empty string.' }
    }
    const validViewId = viewId === undefined ? undefined : validateTargetId(viewId)
    if (validViewId === null) {
      return { ok: false, message: 'notify(...) target.viewId must be a non-empty string when provided.' }
    }
    validatedTarget = { surfaceId: validSurfaceId, ...(validViewId ? { viewId: validViewId } : {}) }
  }
  const trimmedBody = body?.trim()
  return {
    ok: true,
    severity: severity as ModuleNotificationSeverity,
    title: sliceWhole(title.trim(), MAX_TITLE_LENGTH),
    body: trimmedBody ? sliceWhole(trimmedBody, MAX_BODY_LENGTH) : undefined,
    ...(validatedTarget ? { target: validatedTarget } : {}),
  }
}

// Notification text shown for a module failure must not leak install locations
// (mirrors the launch-snapshot sanitizer in third-party-main-loader.ts).
export function sanitizeNotificationText(text: string, fallback: string): string {
  if (/(^|[\s'"])(?:\/[\w.-][^\s'"]*|[A-Za-z]:\\[^\s'"]+)/.test(text)) return fallback
  return text
}
