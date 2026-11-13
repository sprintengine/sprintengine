import { join } from 'node:path'

import { createArtifactPublishRoots, type ArtifactPublishRootsDeps } from '../../main/artifacts/artifact-publish-roots'
import { readArtifactsSiteTemplate, type ArtifactsSiteTemplate } from '../../main/artifacts/artifact-site'
import { settingsWithSiteUrl, type ArtifactsHostDeps } from '../../main/artifacts/artifacts-hosts'
import { createArtifactsService, type ArtifactThumbnailer } from '../../main/artifacts/artifacts-service'
import { createArtifactsSettingsStore } from '../../main/artifacts/artifacts-settings-store'
import { setUpArtifacts } from '../../main/artifacts/artifacts-setup'
import {
  ARTIFACTS_SETUP_CONSENT_TIMEOUT_MS,
  type ArtifactsSetupConsent,
} from '../../main/artifacts/artifacts-setup-consent'
import {
  createArtifactsSetupConsentBroker,
  type ArtifactsSetupQuestions,
} from '../../main/artifacts/artifacts-setup-consent-broker'
import { createArtifactsTools } from '../../main/artifacts/artifacts-tools'
import { listCloudflareAccounts } from '../../main/artifacts/cloudflare-pages-client'
import type { GhApi } from '../../main/artifacts/github-pages'
import { runGitCommand } from '../../main/git-run'
import { sharedGhRunner } from '../../main/github/gh'
import { createGhHostTokenResolver } from '../../main/github/host-token'
import type {
  ArtifactsSettingsView,
  ArtifactsSetupInput,
  ArtifactsSetupQuestionView,
  ArtifactsSetupResult,
} from '../../shared/artifacts'
import type { McpToolRegistration } from '../../shared/modules/mcp-tools'
import { readStudioEnv } from '../../shared/studio-env'
import type { StudioPaths } from '../platform/studio-paths'

// Where a desktop's Studio publishes its agents' pages, as the Studio protocol
// serves it (`artifacts`): Settings ▸ Artifacts, setting a host up, the
// question put to the person before an agent's set-up, and the agents'
// `artifacts.*` tools, all over one service and one setting. The same domain
// in process and out of process; nothing here needs Electron.
//
// Two things are the desktop's shell's, which the core is handed: the picture
// of a page for its card (drawn in a hidden window of the app's Chromium), and
// the native question for when no window is showing. Out of process the
// server asks the shell for each over the control channel.
//
// The Cloudflare token is sealed with this process's secret cipher
// (`studioPlatform().secrets`: the desktop keychain, through the shell out of
// process), and without one lasts for the session only; it never leaves in a
// view, a result, a question or a log line (artifacts-settings-store.ts).

/** What the desktop's shell adds: the page picture, and asking the person with no window showing. */
export type StudioArtifactsShell = {
  /** A picture of a page about to be published; absent, cards have none. */
  thumbnailer?: ArtifactThumbnailer
  /** Whether one of the desktop's windows is showing, to ask the set-up question in. */
  hasWindow(): boolean
  /** The set-up question asked natively, when no window is showing. */
  askNatively: ArtifactsSetupConsent
}

export type StudioArtifactsDeps = StudioArtifactsShell & {
  paths: StudioPaths
  /** The GitHub token this Studio keeps, for github.com; '' for none. */
  resolveGitHubToken(): Promise<string>
  /** The chat a publishing agent belongs to, for the folders it may publish from. */
  findWorkspace: ArtifactPublishRootsDeps['findWorkspace']
  /** The worktree pool's slots and who holds each. */
  poolWorktrees: ArtifactPublishRootsDeps['poolWorktrees']
}

export type StudioArtifacts = {
  /** Settings ▸ Artifacts as the page shows it; never the token. */
  settings(): Promise<ArtifactsSettingsView>
  /** Check the host and find or make what it needs; with `save`, keep what it found. */
  setUp(input: ArtifactsSetupInput, save: boolean): Promise<ArtifactsSetupResult>
  /** The set-up questions open now, oldest first. */
  setupQuestions(): ArtifactsSetupQuestionView[]
  /** Hear the open set-up questions, whole: now and on every change. */
  onSetupQuestions(listener: ArtifactsSetupQuestions): () => void
  /** The person's answer; whether it settled an open question. */
  answerSetupQuestion(id: string, confirmed: boolean): boolean
  /** The agents' `artifacts.*` tools, over the same service. */
  readonly tools: McpToolRegistration[]
}

/**
 * The site's files as they ship: an extraResource in a packaged build
 * (package.json `build.extraResources`), the repository's own folder in a dev
 * build.
 */
function artifactsSiteDir(paths: StudioPaths): string {
  return paths.isPackaged()
    ? join(paths.resourcesDir() ?? '', 'artifacts-site')
    : join(paths.appRoot() ?? process.cwd(), 'resources', 'artifacts-site')
}

/** `gh api` on a host: GitHub Pages is read and turned on through it. */
const ghApi: GhApi = async (host, path, request) => {
  const args = ['api', '--hostname', host, path]
  if (request?.method && request.method !== 'GET') args.push('--method', request.method)
  for (const [key, value] of Object.entries(request?.fields ?? {})) args.push('-f', `${key}=${value}`)
  const answered = await sharedGhRunner().run(args, { timeoutMs: 30_000 })
  if (!answered.found) return { ok: false, status: null, message: 'gh is not installed', notInstalled: true }
  const parse = (text: string): unknown => {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }
  if (answered.code === 0) return { ok: true, status: 200, json: parse(answered.stdout) }
  const status = /HTTP (\d{3})/.exec(answered.stderr)?.[1]
  // gh prints GitHub's own answer on stdout and its summary on stderr.
  const body = parse(answered.stdout) as { message?: unknown } | null
  return {
    ok: false,
    status: status ? Number(status) : null,
    message:
      typeof body?.message === 'string' ? body.message : (answered.stderr.trim().split('\n').pop() ?? 'gh failed'),
  }
}

export function createStudioArtifacts(deps: StudioArtifactsDeps): StudioArtifacts {
  const settingsStore = createArtifactsSettingsStore({ resolveUserDataDir: () => deps.paths.dataDir() })
  const ghHostToken = createGhHostTokenResolver(sharedGhRunner())
  // A stand-in for Cloudflare's API, for a build tried out against one; never set in use.
  const cloudflareApiBase = readStudioEnv('SPRINTENGINE_CLOUDFLARE_API_URL')?.trim() || undefined
  const hostDeps: ArtifactsHostDeps = {
    dataDir: join(deps.paths.dataDir(), 'artifacts'),
    git: (cwd, args, env, options) => runGitCommand(cwd, args, env, options),
    // The saved GitHub token goes to github.com only; any other host, a
    // company's GitHub included, signs in with the one gh holds for it.
    resolveHostToken: async (host) => {
      if (host === 'github.com') {
        const saved = await deps.resolveGitHubToken().catch(() => '')
        if (saved) return saved
      }
      return ghHostToken(host)
    },
    cloudflareToken: () => settingsStore.cloudflareToken(),
    ghApi,
    ...(cloudflareApiBase ? { cloudflareApiBase } : {}),
    // The address the host answered, kept so the tools and the page show it.
    onSiteUrl: (kind, url) => settingsStore.update((current) => settingsWithSiteUrl(current, kind, url)),
  }
  let template: Promise<ArtifactsSiteTemplate> | null = null
  // Read once; a read that failed (the folder missing from a broken install)
  // is tried again next time rather than kept.
  const siteTemplate = () => {
    template ??= readArtifactsSiteTemplate(artifactsSiteDir(deps.paths)).catch((error: unknown) => {
      template = null
      throw error
    })
    return template
  }
  const service = createArtifactsService({
    settings: () => settingsStore.read(),
    hostDeps,
    siteTemplate,
    ...(deps.thumbnailer ? { thumbnailer: deps.thumbnailer } : {}),
    git: (cwd, args) => runGitCommand(cwd, args),
  })
  const setUp = (input: ArtifactsSetupInput, save: boolean): Promise<ArtifactsSetupResult> =>
    setUpArtifacts(input, { save }, { store: settingsStore, hostDeps, siteTemplate })
  // The person is asked in the Studio window they are looking at, natively
  // when no window is showing.
  const consent = createArtifactsSetupConsentBroker({
    hasWindow: deps.hasWindow,
    fallback: deps.askNatively,
    timeoutMs: ARTIFACTS_SETUP_CONSENT_TIMEOUT_MS,
  })
  const tools = createArtifactsTools({
    service,
    publishRoots: createArtifactPublishRoots({
      findWorkspace: deps.findWorkspace,
      poolWorktrees: deps.poolWorktrees,
      appDirs: [hostDeps.dataDir],
    }),
    setup: {
      cloudflareAccount: async (token, accountId) => {
        const use = token || (await settingsStore.cloudflareToken())
        if (!use)
          return {
            ok: false,
            message: 'Ask the person for a Cloudflare API token with the Cloudflare Pages Edit permission.',
          }
        const listed = await listCloudflareAccounts({
          token: use,
          ...(cloudflareApiBase ? { apiBase: cloudflareApiBase } : {}),
        })
        if (!listed.ok) return { ok: false, message: listed.message }
        if (listed.accounts.length === 0) {
          return {
            ok: false,
            message:
              'The token can see no Cloudflare account; the person makes one with Cloudflare Pages Edit on an account.',
          }
        }
        const saved = settingsStore.read().cloudflare.accountId
        const chosen = accountId
          ? listed.accounts.find((account) => account.id === accountId.toLowerCase())
          : (listed.accounts.find((account) => account.id === saved) ??
            (listed.accounts.length === 1 ? listed.accounts[0] : undefined))
        if (chosen) return { ok: true, account: chosen }
        return accountId
          ? { ok: false, message: 'The token cannot see that account.' }
          : { ok: false, message: `The token can see ${listed.accounts.length} accounts.`, accounts: listed.accounts }
      },
      run: (input) => setUp(input, true),
      consent: consent.ask,
    },
  })

  return {
    settings: () => settingsStore.view(),
    setUp,
    setupQuestions: consent.questions,
    onSetupQuestions: consent.onQuestions,
    answerSetupQuestion: consent.answer,
    tools,
  }
}
