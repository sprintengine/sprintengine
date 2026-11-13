import {
  studioNoParams,
  studioParams,
  studioParamsRefused as refuse,
  type StudioMethodTable,
  type StudioParsed,
  type StudioTopicTable,
} from './contract.js'
import { STUDIO_ARTIFACTS_CAPABILITY } from './handshake.js'
import type {
  ArtifactsSettingsView,
  ArtifactsSetupInput,
  ArtifactsSetupQuestionView,
  ArtifactsSetupResult,
} from './artifacts-types.js'

// Where a Studio publishes its agents' pages: Settings ▸ Artifacts as its
// Studio holds it (`artifacts.settings`), setting a host up or testing it
// (`artifacts.setUp`), and the question put to the person before an agent's
// `artifacts.setup` tool changes anything (`artifacts.setupQuestions`, answered
// with `artifacts.answerSetupQuestion`). Offered as `artifacts` where the
// Studio publishes them: a desktop's, in process and out.
//
// The agents' `artifacts.*` tools go through the same service. Publishing,
// changing or removing a page and setting the host up are served on the
// gateway's local socket only; listing, searching and reading the site are
// served on its read scope, as any read is (tailnet-scopes.ts). No client
// lists the site over this protocol: a window opens the site itself.
//
// Grants. Every method and the topic here is an owner's, each with its reason:
// - Reading the setting says which host and account this machine publishes
//   with and whether it holds a Cloudflare token (never the token), as
//   `github.tokenStatus` says of the GitHub token (`STUDIO_ARTIFACTS_SETTING_OWNER`).
// - A set-up signs in to the host with this machine's credentials or the token
//   it is given, turns Pages on or makes a project there, and keeps the token
//   sealed here (`STUDIO_ARTIFACTS_SETUP_OWNER`).
// - The set-up question is the person's at this machine to answer, and only
//   theirs to hear: a yes lets an agent change where this machine publishes
//   (`STUDIO_ARTIFACTS_CONSENT_OWNER`).
//
// The token goes in with a set-up and never comes back out: no result, view,
// question or error carries it.

/** Why reading Settings ▸ Artifacts is an owner's. */
export const STUDIO_ARTIFACTS_SETTING_OWNER =
  'It reads which host and account this machine publishes agents’ pages with, and whether it holds a Cloudflare token for it.'

/** Why setting the artifacts host up is an owner's. */
export const STUDIO_ARTIFACTS_SETUP_OWNER =
  'It signs in to a publishing host with this machine’s credentials or a token it keeps sealed here, and changes where this machine publishes.'

/** Why hearing and answering an agent's set-up question is an owner's. */
export const STUDIO_ARTIFACTS_CONSENT_OWNER =
  'It is the question put to the person at this machine before an agent changes where it publishes; a yes is theirs to give.'

type Commanded<P> = P & { commandId: string }

export type StudioArtifactsMethodMap = {
  /** Settings ▸ Artifacts as the Studio holds it; whether a token is held, never the token. */
  'artifacts.settings': { params: Record<string, never>; result: ArtifactsSettingsView }
  /**
   * Check the host and find or make what it needs, answering each step; with
   * `save`, keep what it found (and the token, when one is given; `''` clears
   * it). A refusal is the result's own `ok: false`, its field named.
   */
  'artifacts.setUp': {
    params: Commanded<{ input: ArtifactsSetupInput; save: boolean }>
    result: ArtifactsSetupResult
  }
  /** The person's answer to an open set-up question; one for a question no longer open does nothing. */
  'artifacts.answerSetupQuestion': {
    params: Commanded<{ id: string; confirmed: boolean }>
    result: { answered: boolean }
  }
}

export type StudioArtifactsTopicMap = {
  /** Every set-up question open now, oldest first: whole, at subscribing and on every change. */
  'artifacts.setupQuestions': {
    params: Record<string, never>
    payload: { questions: ArtifactsSetupQuestionView[] }
    stream: 'push'
  }
}

// ── Validation ──────────────────────────────────────────────────────────────

const COMMAND_ID = '"commandId" names this command: a string of 1 to 200 characters.'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !value.includes('\0')
}
function id(value: unknown): value is string {
  return text(value, 200) && value.length > 0
}

function commanded<P>(
  read: (value: Record<string, unknown>) => StudioParsed<P>,
): (value: Record<string, unknown>) => StudioParsed<Commanded<P>> {
  return (value) => {
    if (!id(value.commandId)) return refuse(COMMAND_ID)
    const parsed = read(value)
    return parsed.ok ? studioParams({ ...parsed.params, commandId: value.commandId }) : parsed
  }
}

/** A host to set up, member by member; the Studio checks what each names when it sets it up. */
function setupInput(value: unknown): StudioParsed<ArtifactsSetupInput> {
  if (!record(value)) return refuse('"input" is the host to set up: { provider, ... }.')
  if (value.provider === null) return studioParams({ provider: null })
  if (value.provider === 'github-pages') {
    if (!text(value.repositoryUrl, 2048)) return refuse('"repositoryUrl" is the repository to publish to.')
    return studioParams({ provider: 'github-pages', repositoryUrl: value.repositoryUrl })
  }
  if (value.provider === 'cloudflare-pages') {
    const out: Extract<ArtifactsSetupInput, { provider: 'cloudflare-pages' }> = { provider: 'cloudflare-pages' }
    const limits = { token: 1000, accountId: 200, projectName: 200, repositoryUrl: 2048 } as const
    for (const key of Object.keys(limits) as Array<keyof typeof limits>) {
      const member = value[key]
      if (member === undefined) continue
      if (!text(member, limits[key])) return refuse(`"${key}" is a string, when given.`)
      out[key] = member
    }
    return studioParams(out)
  }
  return refuse('"provider" is "github-pages", "cloudflare-pages", or null to publish nowhere.')
}

function setUp(value: Record<string, unknown>): StudioParsed<{ input: ArtifactsSetupInput; save: boolean }> {
  if (typeof value.save !== 'boolean') return refuse('"save" is true to keep what the set-up finds, false to test.')
  const input = setupInput(value.input)
  return input.ok ? studioParams({ input: input.params, save: value.save }) : input
}

function answer(value: Record<string, unknown>): StudioParsed<{ id: string; confirmed: boolean }> {
  if (!id(value.id)) return refuse('"id" is the question\'s id.')
  if (typeof value.confirmed !== 'boolean') return refuse('"confirmed" is true only for the person\'s yes.')
  return studioParams({ id: value.id, confirmed: value.confirmed })
}

// ── The table ───────────────────────────────────────────────────────────────

const owner = (reason: string, mutation: boolean) =>
  ({ scope: 'settings:write', mutation, capability: STUDIO_ARTIFACTS_CAPABILITY, owner: reason }) as const

export const STUDIO_ARTIFACTS_METHODS: StudioMethodTable<StudioArtifactsMethodMap> = {
  'artifacts.settings': { ...owner(STUDIO_ARTIFACTS_SETTING_OWNER, false), params: studioNoParams },
  'artifacts.setUp': { ...owner(STUDIO_ARTIFACTS_SETUP_OWNER, true), params: commanded(setUp) },
  'artifacts.answerSetupQuestion': { ...owner(STUDIO_ARTIFACTS_CONSENT_OWNER, true), params: commanded(answer) },
}

export const STUDIO_ARTIFACTS_TOPICS: StudioTopicTable<StudioArtifactsTopicMap> = {
  'artifacts.setupQuestions': {
    scope: 'settings:write',
    capability: STUDIO_ARTIFACTS_CAPABILITY,
    push: true,
    owner: STUDIO_ARTIFACTS_CONSENT_OWNER,
    params: studioNoParams,
  },
}
