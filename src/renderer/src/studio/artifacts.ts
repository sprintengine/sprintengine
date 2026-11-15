import {
  STUDIO_ARTIFACTS_CAPABILITY,
  type ArtifactsSettingsView,
  type ArtifactsSetupInput,
  type ArtifactsSetupQuestionView,
  type ArtifactsSetupResult,
} from '../../../../packages/studio-protocol/src/public'
import { followWindowStudioPush } from './windowStudioPush'
import { windowStudioClient } from './windowStudioClient'

// The window's way to where its Studio publishes agents' pages: Settings ▸
// Artifacts (`artifacts.settings`, `artifacts.setUp`) and the question put to
// the person before an agent's set-up (`artifacts.setupQuestions`, answered
// with `artifacts.answerSetupQuestion`). Over the window's own connection; each
// is an owner's, which a desktop's own window is. A Cloudflare token goes in
// with a set-up and never comes back out.

export type ArtifactsApi = {
  /** The setting as the page shows it; null where the window's Studio publishes none. */
  getArtifactsSettings(): Promise<ArtifactsSettingsView | null>
  /** Test (`save` false) or save a host; a failure to ask is answered as a failed set-up. */
  setUpArtifacts(input: ArtifactsSetupInput, save: boolean): Promise<ArtifactsSetupResult>
  /** The set-up questions open on the Studio, whole, as they change; kept across reconnects. */
  onArtifactsSetupQuestions(cb: (questions: ArtifactsSetupQuestionView[]) => void): () => void
  /** The person's answer to one question. */
  answerArtifactsSetupQuestion(id: string, confirmed: boolean): Promise<void>
}

function commandId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

async function served() {
  const client = await windowStudioClient()
  return client.supports(STUDIO_ARTIFACTS_CAPABILITY) ? client : null
}

export const artifactsApi: ArtifactsApi = {
  getArtifactsSettings: async () => {
    const client = await served()
    return client ? client.request('artifacts.settings', {}) : null
  },
  setUpArtifacts: async (input, save) => {
    try {
      const client = await served()
      if (!client) return { ok: false, steps: [], message: 'This Studio does not publish artifacts.' }
      return await client.request('artifacts.setUp', { input, save, commandId: commandId() })
    } catch (error) {
      return { ok: false, steps: [], message: error instanceof Error ? error.message : String(error) }
    }
  },
  onArtifactsSetupQuestions: (cb) =>
    followWindowStudioPush({
      topic: 'artifacts.setupQuestions',
      params: {},
      capability: STUDIO_ARTIFACTS_CAPABILITY,
      onPayload: (payload) => cb(payload.questions),
    }),
  answerArtifactsSetupQuestion: async (id, confirmed) => {
    const client = await served()
    if (client) await client.request('artifacts.answerSetupQuestion', { id, confirmed, commandId: commandId() })
  },
}
