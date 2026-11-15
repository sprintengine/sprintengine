import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

import type { ArtifactThumbnailer } from '../../main/artifacts/artifacts-service'
import {
  ARTIFACTS_SETUP_CONSENT_TIMEOUT_MS,
  type ArtifactsSetupConsent,
  type ArtifactsSetupConsentQuestion,
} from '../../main/artifacts/artifacts-setup-consent'
import type { ControlRpc } from '../bootstrap/control-rpc'
import { SERVER_EVENTS, SHELL_METHODS } from '../desktop/server-methods'
import type { StudioArtifactsShell } from './artifacts-domain'

// What the artifacts domain needs of the desktop's shell, across the control
// channel when the Studio server runs out of process: a page's picture (a
// hidden window of the app's Chromium) and the set-up question asked natively
// when no window is showing (a message box). Both halves are here, so the
// request and the handler cannot drift. In process the core is handed the
// shell's own functions instead.

/** How much longer than the question itself the server waits for the shell's answer. */
const CONSENT_ANSWER_GRACE_MS = 5_000
/** A page picture is a few hundred kilobytes of PNG; anything far past that is refused. */
const MAX_THUMBNAIL_SIDE = 4096

/** The server's half: the shell's capabilities, asked over the control channel. */
export function shellArtifactsOverControl(
  rpc: Pick<ControlRpc, 'call' | 'emit'>,
  hasWindow: () => boolean,
): StudioArtifactsShell {
  return {
    hasWindow,
    thumbnailer: async (input) => {
      const answer = await rpc.call<{ png?: unknown } | null>(SHELL_METHODS.artifactThumbnail, input).catch(() => null)
      return typeof answer?.png === 'string' && answer.png ? Buffer.from(answer.png, 'base64') : null
    },
    askNatively: async (question, signal) => {
      if (signal.aborted) return false
      const id = randomUUID()
      const onAbort = () => rpc.emit(SERVER_EVENTS.artifactsSetupConsentClosed, { id })
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        const answer = await rpc.call(
          SHELL_METHODS.artifactsSetupConsent,
          { id, question },
          { timeoutMs: ARTIFACTS_SETUP_CONSENT_TIMEOUT_MS + CONSENT_ANSWER_GRACE_MS },
        )
        return answer === true && !signal.aborted
      } catch {
        return false
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    },
  }
}

function side(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_THUMBNAIL_SIDE
}

function words(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4000
}

function consentQuestion(value: unknown): ArtifactsSetupConsentQuestion | null {
  if (!value || typeof value !== 'object') return null
  const { message, detail, confirmLabel, refuseLabel } = value as Record<string, unknown>
  return words(message) && words(detail) && words(confirmLabel) && words(refuseLabel)
    ? { message, detail, confirmLabel, refuseLabel }
    : null
}

/** The shell's half: answer the server's asks with the shell's own window and message box. */
export function serveArtifactsShell(
  rpc: Pick<ControlRpc, 'handle' | 'on'>,
  shell: { thumbnailer: ArtifactThumbnailer; askNatively: ArtifactsSetupConsent },
): void {
  const asking = new Map<string, AbortController>()
  rpc.on(SERVER_EVENTS.artifactsSetupConsentClosed, (payload) => {
    const id = (payload as { id?: unknown } | null)?.id
    if (typeof id === 'string') asking.get(id)?.abort()
  })
  rpc.handle(SHELL_METHODS.artifactThumbnail, async (params) => {
    const { file, width, height } = (params ?? {}) as Record<string, unknown>
    if (typeof file !== 'string' || !isAbsolute(file) || !side(width) || !side(height)) {
      throw new Error('A page picture is asked for with an absolute file and its width and height.')
    }
    const png = await shell.thumbnailer({ file, width, height })
    return png ? { png: png.toString('base64') } : null
  })
  rpc.handle(SHELL_METHODS.artifactsSetupConsent, async (params) => {
    const { id, question } = (params ?? {}) as Record<string, unknown>
    const asked = consentQuestion(question)
    if (typeof id !== 'string' || !id || !asked) throw new Error('A set-up question is asked with its id and words.')
    const controller = new AbortController()
    asking.get(id)?.abort()
    asking.set(id, controller)
    // The shell gives up when the server does, whatever becomes of the channel.
    const timer = setTimeout(() => controller.abort(), ARTIFACTS_SETUP_CONSENT_TIMEOUT_MS)
    try {
      return await shell.askNatively(asked, controller.signal)
    } finally {
      clearTimeout(timer)
      if (asking.get(id) === controller) asking.delete(id)
    }
  })
}
