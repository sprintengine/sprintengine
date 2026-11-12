// What a client may do. A grant is a set of these, read live on every request
// a client makes, so narrowing one or revoking the client applies to the next
// frame and not the next connection.
//
// The names are the tailnet lane's conversation scopes plus `create`, which
// that lane never had: a phone follows and drives chats a person started, and
// a local app may also start them. Each scope is its own grant except that
// `conversation:operate` implies `conversation:read`, as on the tailnet: a
// client that can drive a chat can see what it is driving.
//
// The three read families after them are what a chat view reads beside its
// conversation: the providers and models it can run, files for @-mentions and
// links, and the workspace list. A pairing stored before they existed never
// gains them, since a grant holds exactly the names it was given. A client
// that is not an owner names files only inside the folders Studio knows.
//
// `tools:offer` lets a client give Studio's agents tools of its own (`tools.*`),
// and read the catalog and which chats were opened to a toolset beside it:
// Settings shows it as "Give agents tools from this app", off unless ticked.
// `files:write` is the board files' write half beside `files:read`.
//
// `environment:maintain` lets a client update this Studio (`update.start`):
// download a new version, drain and restart into it. An owner's grant holds
// it; a pairing only when it was given it.
//
// `settings:write` changes this Studio's settings from a client: a provider's
// key, an approval rule revoked, a chat opened to an app's tools. Like
// `environment:maintain`, an owner holds it and a pairing only when it was
// given it.
//
// `modules:read` hears what this Studio's modules say: their events and the
// bell rows they raise, and calls the methods they declare `read`
// (`module.*`). `modules:operate` calls the ones they declare `operate` too,
// and carries `modules:read`. Neither is held to an owner's connection.
//
// No scope reaches the terminals: a terminal is a shell on the machine, so
// only an owner's own connections reach them, never a grant (`terminals.ts`).

/** Every scope this version of the protocol defines, narrowest first. */
export const STUDIO_SCOPES = [
  'conversation:read',
  'conversation:operate',
  'conversation:create',
  'providers:read',
  'files:read',
  'workspaces:read',
  'tools:offer',
  'files:write',
  'environment:maintain',
  'settings:write',
  'modules:read',
  'modules:operate',
] as const

export type StudioScope = (typeof STUDIO_SCOPES)[number]

/** Whether a value names a scope this version of the protocol defines. */
export function isStudioScope(value: unknown): value is StudioScope {
  return (STUDIO_SCOPES as readonly unknown[]).includes(value)
}

/**
 * A grant as stored or received: unknown names dropped, each scope once, in
 * the order `STUDIO_SCOPES` lists them, so two grants holding the same scopes
 * compare equal.
 */
export function normalizeStudioScopes(value: unknown): StudioScope[] {
  if (!Array.isArray(value)) return []
  const held = new Set(value.filter(isStudioScope))
  return STUDIO_SCOPES.filter((scope) => held.has(scope))
}

/** Whether a grant covers `needed`. An `operate` scope covers its `read`. */
export function studioScopesGrant(scopes: readonly string[], needed: StudioScope): boolean {
  if (scopes.includes(needed)) return true
  if (needed === 'modules:read') return scopes.includes('modules:operate')
  return needed === 'conversation:read' && scopes.includes('conversation:operate')
}
