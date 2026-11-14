export type {
  VersionControlProviderId,
  VersionControlProbeFailure,
  VersionControlProbeMachine,
  VersionControlProviderProbe,
} from '../../packages/studio-protocol/src/public'
// Read-only version-control provider facts. The version-control
// settings sections render what the local machine actually has: the probed
// `git`, `gh`, `glab` and `tea` binaries and, for each forge CLI, the login
// its own auth resolves to.
// Nothing here is a stored setting, and there is no partially-filled shape —
// a provider we could not resolve says so, and says why.

// The providers the product integrates. A provider the product does not
// integrate has no id here and therefore no row to render — the renderer draws
// exactly what this list resolves to.
// `glab` and `tea` are here because the chat's Create PR drives them, on
// GitLab and on Gitea, Forgejo and Codeberg (`main/forge-pull-request.ts`).
export { VERSION_CONTROL_PROVIDER_IDS } from '../../packages/studio-protocol/src/public'
