import { randomUUID } from 'node:crypto'

import type { ArtifactsSetupQuestionView } from '../../shared/artifacts'
import type { ArtifactsSetupConsent } from './artifacts-setup-consent'

// Where the set-up question is put to the person: in Studio's own window, as
// a confirmation dialog, the way the app asks what ssh asks (SshPromptDialog).
// The Studio holds the questions open now; the windows follow them over the
// protocol (`artifacts.setupQuestions`, an owner's stream) and the first
// answer (`artifacts.answerSetupQuestion`, an owner's method) settles one, and
// every window then hears it is gone. With no window showing, the desktop's
// shell asks natively instead (artifacts-setup-consent-electron.ts).
//
// Only an owner's connection hears or answers a question: the router holds
// both to one, so a page in the embedded browser, a paired device or a web
// tab without the owner's grant neither sees it nor says yes. An answer for a
// question that is not open, or a second answer, does nothing; the question
// expiring and the call being cancelled are a no.

export type ArtifactsSetupQuestions = (questions: ArtifactsSetupQuestionView[]) => void

export type ArtifactsSetupConsentBroker = {
  ask: ArtifactsSetupConsent
  /** The questions open now, oldest first. */
  questions(): ArtifactsSetupQuestionView[]
  /** Hear the open questions, whole: now, and on every change. Returns the unsubscriber. */
  onQuestions(listener: ArtifactsSetupQuestions): () => void
  /** The person's answer, from an owner's connection; whether it settled an open question. */
  answer(id: string, confirmed: boolean): boolean
}

export function createArtifactsSetupConsentBroker(deps: {
  /** Whether one of the desktop's windows is showing, to ask in. */
  hasWindow: () => boolean
  /** The question asked natively, when no window could show it. */
  fallback: ArtifactsSetupConsent
  timeoutMs: number
  now?: () => number
}): ArtifactsSetupConsentBroker {
  const now = deps.now ?? Date.now
  const open = new Map<string, { view: ArtifactsSetupQuestionView; settle: (confirmed: boolean) => void }>()
  const listeners = new Set<ArtifactsSetupQuestions>()
  const questions = () => [...open.values()].map((entry) => entry.view)
  const changed = () => {
    const current = questions()
    for (const listener of [...listeners]) listener(current)
  }

  return {
    ask(question, signal) {
      if (!deps.hasWindow()) return deps.fallback(question, signal)
      return new Promise<boolean>((resolve) => {
        const id = randomUUID()
        const settle = (confirmed: boolean) => {
          if (!open.has(id)) return
          open.delete(id)
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          changed()
          resolve(confirmed)
        }
        const onAbort = () => settle(false)
        const timer = setTimeout(() => settle(false), deps.timeoutMs)
        open.set(id, { view: { id, ...question, expiresAt: now() + deps.timeoutMs }, settle })
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) return settle(false)
        changed()
      })
    },
    questions,
    onQuestions(listener) {
      listeners.add(listener)
      listener(questions())
      return () => void listeners.delete(listener)
    },
    answer(id, confirmed) {
      const entry = open.get(id)
      if (!entry) return false
      entry.settle(confirmed)
      return true
    },
  }
}
