// The shapes the artifacts family (`artifacts.ts`) carries: where a Studio
// publishes its agents' pages (Settings ▸ Artifacts), a set-up of that host
// and what it found, and the question put to the person before an agent's
// set-up changes anything. `src/shared/artifacts.ts` re-exports each under
// the name the app has always used, beside the rules that read them.

export const ARTIFACTS_PROVIDERS = ['github-pages', 'cloudflare-pages'] as const
export type ArtifactsProviderKind = (typeof ARTIFACTS_PROVIDERS)[number]

export type GitHubPagesSettings = {
  /** The repository as the person gave it: an https or ssh URL, or `owner/name` on github.com. */
  repositoryUrl: string
  /** The site's address as GitHub Pages answered it (`html_url`); Studio's to fill. */
  siteUrl: string
}

export type CloudflarePagesSettings = {
  /** The account the token sees, as found (or picked); Studio's to fill. */
  accountId: string
  accountName: string
  /** The project's name, when not the default; under Advanced. */
  projectName: string
  /** A git repository to keep the site's source and history in, when wanted; under Advanced. */
  repositoryUrl: string
  /** The site's address as the project answered it; Studio's to fill. */
  siteUrl: string
}

/** What the Studio keeps in plain settings. The Cloudflare token is never here: it is sealed apart. */
export type ArtifactsSettings = {
  provider: ArtifactsProviderKind | null
  github: GitHubPagesSettings
  cloudflare: CloudflarePagesSettings
}

/** The setting as the page shows it. */
export type ArtifactsSettingsView = ArtifactsSettings & {
  /** Whether a Cloudflare token is held, never the token. */
  cloudflareToken: { configured: boolean; encryptionAvailable: boolean }
  /** The address the gallery is served at, for the chosen host, or null while it is not set up. */
  siteUrl: string | null
}

/** What the person (or an agent, with the person's confirmation) asks to set up. */
export type ArtifactsSetupInput =
  | { provider: null }
  | { provider: 'github-pages'; repositoryUrl: string }
  | {
      provider: 'cloudflare-pages'
      /** A new token; left out, the saved one. */
      token?: string
      /** The account to use, when the token sees several. */
      accountId?: string
      projectName?: string
      repositoryUrl?: string
    }

export type ArtifactsSetupField =
  | 'provider'
  | 'github.repositoryUrl'
  | 'cloudflare.token'
  | 'cloudflare.accountId'
  | 'cloudflare.projectName'
  | 'cloudflare.repositoryUrl'

/**
 * One line of a set-up or a check: what was looked at or done, how it went,
 * and what it found. `warn` passed with something left to do (Pages still
 * building): publishing works, the site may not show it yet.
 */
export type ArtifactsCheck = { label: string; status: 'pass' | 'warn' | 'fail'; detail: string }

export type ArtifactsSetupResult =
  | { ok: true; steps: ArtifactsCheck[]; siteUrl: string | null; saved: boolean; view: ArtifactsSettingsView }
  | {
      ok: false
      steps: ArtifactsCheck[]
      field?: ArtifactsSetupField
      message: string
      /** The token sees several accounts: the person picks one, and it is asked again with `accountId`. */
      accounts?: Array<{ id: string; name: string }>
    }

/** The set-up question as a Studio window shows it, until it is answered or expires. */
export type ArtifactsSetupQuestionView = {
  id: string
  message: string
  detail: string
  confirmLabel: string
  refuseLabel: string
  expiresAt: number
}
