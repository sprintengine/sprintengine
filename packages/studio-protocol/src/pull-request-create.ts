import { studioParams, studioParamsRefused as refuse, type StudioMethodTable } from './contract.js'
import { STUDIO_PULL_REQUEST_CREATE_CAPABILITY } from './handshake.js'
import {
  parseStudioPullRequestOwner,
  type StudioPullRequestForge,
  type StudioPullRequestOwner,
} from './pull-requests.js'

// Opening a pull request from a chat, on the Studio that holds the chat: the
// chat's "Create PR" (owner ruling 2026-10-04). The checkout, git, the
// forge's CLI and the agent CLI that drafts the text are all on that Studio's
// machine, so every step runs there, in the chat's own checkout. A call names
// the CHAT, never a folder: the Studio resolves the folder the chat works in
// from its own record. The steps are separate so a client can say which one
// it is on: whether the button may show, the draft, the push, the creation.
//
// Each is held to the chat, not to an owner: a client that may drive the chat
// (`conversation:operate`, a paired desktop's window among them) may draft,
// push and open its pull request, as it could over the paired lane's tools
// before; whether the button may show is a read beside the chat's list. A
// call reaches no checkout but the chat's own, and learns no path on this
// disk. A pull request created here is recorded as the chat's here, where its
// record lives.

/** Why the button is not drawn, for the tests and the diagnostics line; `ready` draws it. */
export type StudioCreatePullRequestReadiness =
  | { ready: true }
  | {
      ready: false
      reason:
        'detached' | 'default-branch' | 'nothing-to-propose' | 'open-pull-request' | 'no-remote' | 'unsupported-forge'
    }

/** What the strip needs to decide on the button. Null fields are facts git could not give. */
export type StudioCreatePullRequestState = {
  readiness: StudioCreatePullRequestReadiness
  /** The checkout's root; null over the protocol, which names no path on the Studio's disk. */
  gitRoot: string | null
  branch: string | null
  /** The commit the branch is at, which a confirmed Create PR pushes and proposes. */
  headSha: string | null
  /**
   * Paths with uncommitted changes (tracked, staged or not, and untracked
   * files git does not ignore), which the pull request will not include; null
   * when git could not say.
   */
  uncommittedChanges: number | null
  base: string | null
  forge: 'github' | StudioPullRequestForge | null
}

/**
 * The branch and commit a person confirmed a pull request for. The push and
 * the creation are refused when the checkout has moved off it since, rather
 * than proposing a branch or commits they did not see.
 */
export type StudioPullRequestCheckoutPin = { branch: string; headSha: string }

/** The longest title and description a creation takes; what is longer is cut, as the dialog's field cuts a title. */
export const STUDIO_PULL_REQUEST_TITLE_MAX_CHARS = 300
export const STUDIO_PULL_REQUEST_BODY_MAX_CHARS = 65_000

/**
 * A pin as a client sent it, or null when it is not one: a branch name git
 * could hold and a commit id.
 */
export function readStudioPullRequestCheckoutPin(value: unknown): StudioPullRequestCheckoutPin | null {
  if (!value || typeof value !== 'object') return null
  const { branch, headSha } = value as Record<string, unknown>
  if (typeof branch !== 'string' || !branch || branch.length > 255 || branch.includes('\0')) return null
  if (typeof headSha !== 'string' || !/^[0-9a-f]{7,64}$/iu.test(headSha)) return null
  return { branch, headSha }
}

/**
 * A creation's end: created by the forge's CLI, already there, a forge page to
 * open, the forge's list to look in, or why not. The client opens the address
 * and says what happened; the sentences about a page or list are its to write,
 * because only it learns whether the page actually opened.
 */
export type StudioCreatePullRequestOutcome =
  | { ok: true; kind: 'created'; url: string }
  /** The branch had one already, whoever opened it; shown, never linked to the chat. */
  | { ok: true; kind: 'existing'; url: string }
  | {
      ok: true
      kind: 'page'
      url: string
      /** How the strip names the forge whose page it is: GitLab by name, a Gitea or Bitbucket by its host. */
      place: string
      /**
       * Why the page opens rather than the request being created here (the
       * forge's CLI is missing, signed out or failed), for the strip to say.
       * Absent on a forge the app has no CLI for, where the page is the way.
       */
      reason?: string
      /**
       * The description was not put in the page's address (the forge's page
       * takes none, or it was too long for an address), so the client keeps
       * it for the person to paste rather than losing what they wrote.
       */
      descriptionLeftOut?: true
    }
  | {
      ok: true
      /**
       * The forge's CLI may well have opened the request, but its address
       * could not be read. `url` is the repository's list of requests, where
       * the person can find it: opening the "new request" page instead would
       * invite a second one.
       */
      kind: 'list'
      url: string
      place: string
      /** What is not known, for the strip to say. */
      reason: string
    }
  | { ok: false; message: string }

export type StudioPushForPullRequestOutcome = { ok: true; pushed: boolean } | { ok: false; message: string }

/** A drafted title and description, or why there is none (`text_generation_off`: write it yourself). */
export type StudioPullRequestDraftOutcome =
  | { ok: true; title: string; body: string }
  | { ok: false; code: 'text_generation_off' | 'cancelled' | 'draft_failed'; message: string }

/**
 * A creation, and for one the Studio created, whether it was recorded as the
 * chat's (`recordMessage` says why not, with the address: the pull request
 * exists either way).
 */
export type StudioPullRequestCreated =
  | Exclude<StudioCreatePullRequestOutcome, { kind: 'created' }>
  | { ok: true; kind: 'created'; url: string; recorded: boolean; recordMessage?: string }

type Chat = { conversation: StudioPullRequestOwner }

export type StudioPullRequestCreateMethodMap = {
  /** Whether the chat's checkout is ready for a pull request; `state` null where it is not a checkout here. */
  'pullRequests.createState': {
    params: Chat
    result: { state: StudioCreatePullRequestState | null }
    /** No such chat here. */
    errors: 'not_found'
  }
  /**
   * Draft a title and description from the chat's branch with the Studio's
   * own text generation settings, named by the client's `draftId` so
   * `draftCancel` can stop it.
   */
  'pullRequests.draft': {
    params: Chat & { draftId: string }
    result: StudioPullRequestDraftOutcome
    errors: 'not_found'
  }
  /** Stop a draft this client started; another client's is passed over. */
  'pullRequests.draftCancel': { params: Chat & { draftId: string }; result: Record<string, never> }
  /** Push the chat's branch to its push remote where that does not have all of it, pinned to what was seen. */
  'pullRequests.push': {
    params: Chat & { commandId: string; pin?: StudioPullRequestCheckoutPin }
    result: StudioPushForPullRequestOutcome
    errors: 'not_found'
  }
  /** Open the pull request with the forge's CLI, recorded as the chat's when created. */
  'pullRequests.create': {
    params: Chat & { commandId: string; title: string; body: string; pin?: StudioPullRequestCheckoutPin }
    result: StudioPullRequestCreated
    errors: 'not_found'
  }
}

const held = (scope: 'conversation:read' | 'conversation:operate', mutation: boolean) =>
  ({ scope, mutation, capability: STUDIO_PULL_REQUEST_CREATE_CAPABILITY }) as const

const CONVERSATION = '"conversation" is { workspaceId, agentId }.'
const DRAFT_ID = '"draftId" names the draft: a string of 1 to 200 characters.'
const COMMAND_ID = '"commandId" must be a string of 1 to 200 characters.'
const PIN = '"pin" is the branch and commit the state answered.'

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

function chat(value: Record<string, unknown>): Chat | null {
  const conversation = parseStudioPullRequestOwner(value.conversation)
  return conversation ? { conversation } : null
}

function pinned(value: Record<string, unknown>): { pin?: StudioPullRequestCheckoutPin } | null {
  if (value.pin === undefined) return {}
  const pin = readStudioPullRequestCheckoutPin(value.pin)
  return pin ? { pin } : null
}

export const STUDIO_PULL_REQUEST_CREATE_METHODS: StudioMethodTable<StudioPullRequestCreateMethodMap> = {
  'pullRequests.createState': {
    ...held('conversation:read', false),
    params: (value) => {
      const at = chat(value)
      return at ? studioParams(at) : refuse(CONVERSATION)
    },
  },
  'pullRequests.draft': {
    ...held('conversation:operate', false),
    params: (value) => {
      const at = chat(value)
      if (!at) return refuse(CONVERSATION)
      return id(value.draftId) ? studioParams({ ...at, draftId: value.draftId }) : refuse(DRAFT_ID)
    },
  },
  'pullRequests.draftCancel': {
    ...held('conversation:operate', false),
    params: (value) => {
      const at = chat(value)
      if (!at) return refuse(CONVERSATION)
      return id(value.draftId) ? studioParams({ ...at, draftId: value.draftId }) : refuse(DRAFT_ID)
    },
  },
  'pullRequests.push': {
    ...held('conversation:operate', true),
    params: (value) => {
      const at = chat(value)
      if (!at) return refuse(CONVERSATION)
      if (!id(value.commandId)) return refuse(COMMAND_ID)
      const pin = pinned(value)
      return pin ? studioParams({ ...at, commandId: value.commandId, ...pin }) : refuse(PIN)
    },
  },
  'pullRequests.create': {
    ...held('conversation:operate', true),
    params: (value) => {
      const at = chat(value)
      if (!at) return refuse(CONVERSATION)
      if (!id(value.commandId)) return refuse(COMMAND_ID)
      if (typeof value.title !== 'string' || !value.title.trim() || typeof value.body !== 'string')
        return refuse('"title" and "body" are the pull request’s text.')
      const pin = pinned(value)
      if (!pin) return refuse(PIN)
      return studioParams({
        ...at,
        commandId: value.commandId,
        title: value.title.trim().slice(0, STUDIO_PULL_REQUEST_TITLE_MAX_CHARS),
        body: value.body.slice(0, STUDIO_PULL_REQUEST_BODY_MAX_CHARS),
        ...pin,
      })
    },
  },
}
