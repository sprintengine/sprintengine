// What an extension hands the person's agents and chats without running any
// code of its own in Studio: skills (folders an agent reads), MCP server
// definitions (a local command an agent starts, or a hosted server it
// reaches) and model providers (an OpenAI-compatible endpoint a chat talks
// to). The rules here are shared by the manifest validator, the install review
// and the host that projects them, so the three cannot disagree. Pure (no Node
// or DOM APIs).

/** The token a local MCP server's command, arguments and environment use for the extension's installed folder. */
export const EXTENSION_PATH_TOKEN = '${extensionPath}'

/** A program found on the agent's PATH: a bare name, no folder. */
const PROGRAM_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/

/** Why `value` is not a command a local MCP server may run, or null. */
export function mcpCommandProblem(value: string): string | null {
  if (value.startsWith(EXTENSION_PATH_TOKEN)) {
    const rest = value.slice(EXTENSION_PATH_TOKEN.length)
    if (!rest.startsWith('/') || !isContainedRelativePath(rest.slice(1)))
      return `must name a file inside the extension, as ${EXTENSION_PATH_TOKEN}/path/to/file.`
    return null
  }
  if (!PROGRAM_RE.test(value))
    return `must be a program on the PATH (such as node or npx) or a file inside the extension, as ${EXTENSION_PATH_TOKEN}/path/to/file.`
  return null
}

/** Why an argument or environment value misuses the extension-path token, or null. */
export function extensionPathUseProblem(value: string): string | null {
  let at = value.indexOf(EXTENSION_PATH_TOKEN)
  while (at !== -1) {
    const rest = value.slice(at + EXTENSION_PATH_TOKEN.length)
    const segment = rest.split(/[\s"'=:;,]/, 1)[0] ?? ''
    if (segment !== '' && (!segment.startsWith('/') || !isContainedRelativePath(segment.slice(1))))
      return `uses ${EXTENSION_PATH_TOKEN} for a path outside the extension.`
    at = value.indexOf(EXTENSION_PATH_TOKEN, at + EXTENSION_PATH_TOKEN.length)
  }
  return null
}

function isContainedRelativePath(path: string): boolean {
  if (path === '') return true
  if (path.includes('\\') || path.includes('\0')) return false
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/** Replace the extension-path token with the installed folder. */
export function withExtensionPath(value: string, extensionPath: string): string {
  return value.split(EXTENSION_PATH_TOKEN).join(extensionPath)
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Why `value` is not a URL an extension may name for a hosted MCP server or
 * a provider, or null: `https`, or plain `http` to this machine only (a model
 * server or MCP server running here), with no user name, password or
 * fragment, which would carry a secret or be dropped.
 */
export function agentEndpointUrlProblem(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'must be an absolute URL.'
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)))
    return 'must use https (plain http only to localhost).'
  if (url.username !== '' || url.password !== '') return 'must not carry a user name or password.'
  if (url.hash !== '') return 'must not carry a fragment.'
  return null
}

/** The origin a provider's key is sent to: its base URL's scheme, host and port. */
export function providerOrigin(baseUrl: string): string {
  return new URL(baseUrl).origin
}

/**
 * Why `path` is not a provider endpoint path, or null: one leading slash and
 * nothing that could move the request off the base URL's origin (a second
 * slash, a backslash, a scheme, a `..`).
 */
export function providerPathProblem(path: string): string | null {
  if (!path.startsWith('/') || path.startsWith('//')) return 'must start with a single /.'
  if (path.includes('\\')) return 'must not hold a backslash.'
  if (/[\s\0]/.test(path)) return 'must not hold spaces or control characters.'
  if (path.split(/[/?#]/).some((segment) => segment === '..' || segment === '.'))
    return 'must not hold . or .. segments.'
  return null
}

/** Where a provider request goes: `path` on `baseUrl`, held to the base URL's origin. */
export function providerEndpoint(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl)
  const url = new URL(path, base)
  if (url.origin !== base.origin) throw new Error(`The provider path ${path} leaves ${base.origin}.`)
  return url
}

/**
 * The id Studio knows an extension's provider by, and stores its key under:
 * `<publisher>.<id>/<providerId>`, so no two extensions' providers, and no
 * extension's and a built-in's, can share one.
 */
export function extensionProviderId(installKey: string, providerId: string): string {
  return `${installKey}/${providerId}`
}

/**
 * The name an extension's MCP server is handed to agents under:
 * `<publisher>_<id>_<serverId>`. An underscore never appears in an id or a
 * publisher, so the name cannot be another extension's, and it is a key every
 * agent's configuration takes.
 */
export function extensionMcpServerName(installKey: string, serverId: string): string {
  return `${installKey.replace('.', '_')}_${serverId}`
}

/** The name an extension's skill is handed to agents under: `<publisher>.<id>.<skillId>`. */
export function extensionSkillName(installKey: string, skillId: string): string {
  return `${installKey}.${skillId}`
}
