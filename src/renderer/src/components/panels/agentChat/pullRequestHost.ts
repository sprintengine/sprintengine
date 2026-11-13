import type {
  CreatePullRequestOutcome,
  CreatePullRequestState,
  PullRequestCheckoutPin,
  PushForPullRequestOutcome,
} from '../../../../../shared/git/pull-request-create'
import type { MeshConversationKey } from '../../../../../shared/tailnet-mesh'
import type { StudioClient } from '../../../../../../packages/client-runtime/src/public'
import { STUDIO_PULL_REQUEST_CREATE_CAPABILITY } from '../../../../../../packages/studio-protocol/src/public'
import { randomId } from '../../../../../shared/random-id'
import { windowStudioClient } from '../../../studio/windowStudioClient'

// Where the chat's "Create PR" does its work. The button, its dialog and the
// sentences on the strip are the same for every chat (owner ruling
// 2026-10-18: apart from the machine's mark, a remote chat looks and behaves
// as a local one); what differs is which machine reads the checkout, writes
// the draft, pushes and opens the pull request. A chat on this window's
// Studio asks that Studio over the protocol; a chat followed over a paired
// machine's lane asks that machine. Each works in the chat's own checkout,
// with its own text generation settings. Opening the forge's page
// and the clipboard stay on this computer, in front of the person, whichever
// machine did the work.

/** A drafted title and description, or the sentence the dialog shows instead. */
export type PullRequestDraftOutcome = { ok: true; title: string; body: string } | { ok: false; message: string }

/** A draft as a host starts it: refused at once (nothing here can write one), or being written. */
export type PullRequestDraft = { refused: string } | { written: Promise<PullRequestDraftOutcome> }

export type PullRequestHost = {
  /** Whether the checkout is ready to propose; null when it cannot say (not a checkout, no shell to ask). */
  state(): Promise<CreatePullRequestState | null>
  /** Draft a title and description, named so `cancelDraft` can stop it. */
  draft(draftId: string): PullRequestDraft
  cancelDraft(draftId: string): Promise<void>
  push(pin?: PullRequestCheckoutPin): Promise<PushForPullRequestOutcome>
  create(text: { title: string; body: string }, pin?: PullRequestCheckoutPin): Promise<CreatePullRequestOutcome>
  /** Record a pull request it created as the conversation's. */
  link(url: string, title: string): Promise<{ ok: true } | { ok: false; message: string }>
}

const draftFailed = (message: string) => `The draft could not be written: ${message}`

/** What a host asks of a Studio: its calls, and whether it serves one. */
type PullRequestStudio = Pick<StudioClient, 'request' | 'supports'>

/**
 * A chat on this window's Studio, every step asked of that Studio
 * (`pull-request-create`), in the chat's own checkout there, with its own
 * text generation settings. It records a pull request it creates as the
 * chat's itself, so `link` here only says how that went.
 */
export function studioPullRequestHost(
  conversation: { workspaceId: string; agentId: string },
  client: () => Promise<PullRequestStudio> = windowStudioClient,
): PullRequestHost {
  const recorded = new Map<string, { ok: true } | { ok: false; message: string }>()
  // A Studio from before Create PR was a protocol method does not serve it,
  // and is not asked: the button stays hidden.
  const studio = async () => {
    const connected = await client()
    if (!connected.supports(STUDIO_PULL_REQUEST_CREATE_CAPABILITY))
      throw new Error('This Studio is older than this window and cannot open a pull request. Update it.')
    return connected
  }
  const failed = (error: unknown) => (error instanceof Error ? error.message : String(error))
  return {
    state: async () => {
      const connected = await client().catch(() => null)
      if (!connected?.supports(STUDIO_PULL_REQUEST_CREATE_CAPABILITY)) return null
      const read = await connected.request('pullRequests.createState', { conversation }).catch(() => null)
      return read?.state ?? null
    },
    draft: (draftId) => ({
      written: studio()
        .then((connected) => connected.request('pullRequests.draft', { conversation, draftId }))
        .then((result) =>
          result.ok
            ? { ok: true as const, title: result.title, body: result.body }
            : // Text generation being off is said as it is, not as a failure.
              {
                ok: false as const,
                message: result.code === 'text_generation_off' ? result.message : draftFailed(result.message),
              },
        )
        .catch((error: unknown) => ({ ok: false as const, message: draftFailed(failed(error)) })),
    }),
    cancelDraft: async (draftId) => {
      await studio()
        .then((connected) => connected.request('pullRequests.draftCancel', { conversation, draftId }))
        .catch(() => undefined)
    },
    push: (pin) =>
      studio()
        .then((connected) =>
          connected.request('pullRequests.push', { conversation, commandId: randomId(), ...(pin ? { pin } : {}) }),
        )
        .catch((error: unknown) => ({ ok: false as const, message: failed(error) })),
    create: async (text, pin) => {
      const created = await studio()
        .then((connected) =>
          connected.request('pullRequests.create', {
            conversation,
            commandId: randomId(),
            ...text,
            ...(pin ? { pin } : {}),
          }),
        )
        .catch((error: unknown) => ({ ok: false as const, message: failed(error) }))
      if (!created.ok || created.kind !== 'created') return created
      recorded.set(
        created.url,
        created.recorded ? { ok: true } : { ok: false, message: created.recordMessage ?? 'It was not recorded.' },
      )
      return { ok: true, kind: 'created', url: created.url }
    },
    link: async (url) => {
      const outcome = recorded.get(url) ?? { ok: true }
      recorded.delete(url)
      return outcome
    },
  }
}

/**
 * A chat on a paired machine, every step asked of that machine
 * (`chat-create-pull-request`). It records a pull request it creates as the
 * chat's itself, so `link` here only says how that went and asks for the
 * machine's list again, which flips the slot to "Open PR #N".
 */
export function remotePullRequestHost(key: MeshConversationKey, onRecorded: () => void): PullRequestHost {
  const recorded = new Map<string, { ok: true } | { ok: false; message: string }>()
  return {
    state: async () => {
      const result = await window.api.meshConversationPullRequestState({ key })
      return result.ok ? result.state : null
    },
    draft: (draftId) => ({
      written: window.api.meshConversationPullRequestDraft({ key, draftId }).then((result) =>
        result.ok
          ? { ok: true as const, title: result.title, body: result.body }
          : // That machine's text generation being off is said as it is, not as a failure.
            {
              ok: false as const,
              message: result.code === 'text_generation_off' ? result.message : draftFailed(result.message),
            },
      ),
    }),
    cancelDraft: async (draftId) => {
      await window.api.meshConversationPullRequestDraftCancel({ key, draftId })
    },
    push: (pin) => window.api.meshConversationPullRequestPush({ key, ...(pin ? { pin } : {}) }),
    create: async (text, pin) => {
      const created = await window.api.meshConversationPullRequestCreate({ key, ...text, ...(pin ? { pin } : {}) })
      if (!created.ok || created.kind !== 'created') return created
      recorded.set(created.url, created.recorded)
      return { ok: true, kind: 'created', url: created.url }
    },
    link: async (url) => {
      const outcome = recorded.get(url) ?? { ok: true }
      recorded.delete(url)
      onRecorded()
      return outcome
    },
  }
}
