// What a `sprintengine://` link may ask of a Studio client, and nothing more:
// one grammar, read the same way by the desktop and the phone.
//
// A link is untrusted input: any web page or app on the device can open one,
// and the OS hands it over without asking the person. So the grammar is a short
// allowlist, read by hand rather than by `new URL` (which resolves `..` and
// folds what it cannot read into something it can), and everything it does not
// name is a link that is ignored:
//
//   sprintengine://auth/callback?…                        the sign-in callback,
//                                                         which the desktop's
//                                                         auth service reads
//   sprintengine://chat/<environmentId>/<chatId>          open that chat, in
//                                                         the Studio that holds it
//   sprintengine://chat/<environmentId>/<chatId>?agent=<id>  …on that agent's tab
//
// A link a build before environments wrote, `sprintengine://chat/<chatId>`, is
// still read, with no environment: the client looks for the chat among every
// environment it lists (one opens, several are offered, none is said). Nothing
// writes that form any more.
//
// A chat link only navigates. It never starts an agent, never puts words in a
// composer and never sends anything; there is deliberately no link that does,
// because a page the person happened to visit would be the one deciding. The
// ids it carries are matched against the chats on record and go nowhere else:
// not into a path, not into a command.
//
// No imports: the phone builds this file on its own.

/** The scheme a Studio client registers with the OS and writes its links in. */
export const STUDIO_LINK_SCHEME = 'sprintengine' as const

/** Every scheme a Studio client answers to: today only `STUDIO_LINK_SCHEME`. */
export const STUDIO_LINK_SCHEMES = [STUDIO_LINK_SCHEME] as const

/** A chat a link names, and the agent whose tab comes forward. */
export type ChatLink = {
  kind: 'chat'
  /**
   * The environment that holds the chat (`EnvironmentId`). Null for a link
   * from before links named one: the client resolves it among the chats it
   * lists.
   */
  environmentId: string | null
  /** The chat's id in that environment: its workspace record's id. */
  chatId: string
  /** One of its agents, whose tab comes forward; null for the chat as it was left. */
  agentId: string | null
}

export type StudioLink = { kind: 'auth' } | ChatLink

// Far longer than any link a client writes, and short enough that nothing is
// spent on a megabyte of query string.
const MAX_LINK_LENGTH = 2048

// Every id a Studio mints fits (a UUID, nanoid, the registry's hex,
// `agent-<cli>-<suffix>`), and nothing that could mean something else to a
// shell or a file system does: no dot, slash, percent, quote, space or colon.
// The same rule as `isEnvironmentId` and `isChatAddress`, so a chat with an
// address always has a link (the package's test pins the two together).
const LINK_ID = /^[A-Za-z0-9_-]{1,128}$/

// scheme :// authority path ? query # fragment, each part taken as written.
const LINK_SHAPE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#.*)?$/

// Anything at or below a space, and DEL: a link the OS handed over intact has
// none, and one that does is not a link a client wrote.
const CONTROL_OR_SPACE = /[\u0000- \u007f]/

// One or two id segments, and the trailing slash some browsers on Windows add
// to a link they hand to its app.
const CHAT_PATH = /^\/([^/]+)(?:\/([^/]+))?\/?$/

/** Whether a value is an id a link carries as it is: 1 to 128 characters of `[A-Za-z0-9_-]`. */
export function isLinkId(value: unknown): value is string {
  return typeof value === 'string' && LINK_ID.test(value)
}

/** What the link asks for; null for anything that is not one of Studio's links. */
export function parseStudioLink(raw: unknown): StudioLink | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LINK_LENGTH) return null
  if (CONTROL_OR_SPACE.test(raw)) return null
  const shape = LINK_SHAPE.exec(raw)
  if (!shape) return null
  const [, scheme = '', authority = '', path = '', query = ''] = shape
  // Scheme and host are case-insensitive, and nothing promises which case the
  // OS hands back. A user, password or port makes the authority something
  // other than the bare word, so it is refused here too.
  if (!(STUDIO_LINK_SCHEMES as readonly string[]).includes(scheme.toLowerCase())) return null
  const host = authority.toLowerCase()

  if (host === 'auth') return path === '/callback' ? { kind: 'auth' } : null
  if (host !== 'chat') return null

  const segments = CHAT_PATH.exec(path)
  if (!segments) return null
  const [, first = '', second] = segments
  const environmentId = second === undefined ? null : first
  const chatId = second ?? first
  if (!LINK_ID.test(chatId) || (environmentId !== null && !LINK_ID.test(environmentId))) return null

  // The one parameter read. Any other is ignored rather than refused, so a link
  // a newer build writes still opens its chat here. An agent named twice, or
  // not in the id alphabet, is dropped and the chat still opens.
  const agents = queryValues(query, 'agent')
  const agent = agents.length === 1 ? agents[0] : null
  return { kind: 'chat', environmentId, chatId, agentId: agent && LINK_ID.test(agent) ? agent : null }
}

/** The chat link a value is, or null for any other link or none. */
export function parseChatLink(raw: unknown): ChatLink | null {
  const link = parseStudioLink(raw)
  return link?.kind === 'chat' ? link : null
}

/**
 * The link that opens a chat where it is, or null when an id is one a link
 * cannot carry (an id from before the alphabet above, say), so a menu never
 * offers to copy a link that would not open.
 */
export function chatLinkFor(
  address: { environmentId: string; chatId: string },
  agentId?: string | null,
): string | null {
  if (!LINK_ID.test(address.environmentId) || !LINK_ID.test(address.chatId)) return null
  if (agentId != null && !LINK_ID.test(agentId)) return null
  const base = `${STUDIO_LINK_SCHEME}://chat/${address.environmentId}/${address.chatId}`
  return agentId ? `${base}?agent=${agentId}` : base
}

/**
 * One query parameter's values, as `URLSearchParams.getAll` reads them (`+` a
 * space, escapes decoded, in keys too), by hand so every client reads them the
 * same; null for a value that will not decode.
 */
function queryValues(query: string, name: string): (string | null)[] {
  const decode = (part: string): string | null => {
    try {
      return decodeURIComponent(part.replace(/\+/g, ' '))
    } catch {
      return null
    }
  }
  return query
    .split('&')
    .filter(Boolean)
    .flatMap((pair) => {
      const at = pair.indexOf('=')
      const key = decode(at < 0 ? pair : pair.slice(0, at))
      return key === name ? [decode(at < 0 ? '' : pair.slice(at + 1))] : []
    })
}
