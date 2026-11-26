import type { StudioWindowTicket } from '../../../shared/studio-connection'
import type { WindowStudioSetup } from '../studio/windowStudioClient'
import { returnToPairing, webPageUrl, webSocketUrl } from './webLocation'
import { WEB_CLOSE_REVOKED, WEB_STUDIO_REOPENED_EVENT } from './webReconnect'

// A web tab's connections to the Studio protocol: a WebSocket to `/ws` on the
// server that served the tab, as a desktop window's goes to its own server's
// window listener. The socket's upgrade carries the session cookie, which the
// server checks with the `Origin`; the hello's credential is a placeholder the
// server does not read, because the upgrade already proved who this is (phase
// 9 spec, 3.5). Everything above (the client, its reconnects and resumes) is
// the desktop window's.

/** The credential a cookie-authenticated socket says hello with (a credential is 16 to 256 printable characters). The server reads the session, not this. */
export const WEB_SESSION_CREDENTIAL = 'web-session-cookie'

/** Where the tab's next connection goes: the cookie is its ticket. */
export async function webStudioTicket(): Promise<StudioWindowTicket> {
  return { url: webSocketUrl('ws'), token: WEB_SESSION_CREDENTIAL }
}

/**
 * Whether this browser is still paired: a socket refused at its upgrade (a
 * browser removed while the tab slept is refused there, with a 401 the page
 * cannot read) closes without a code, so the session is asked. Removed, the
 * tab goes back to pairing; a server that is not there leaves the backoff to
 * try again.
 */
export async function checkStillPaired(
  fetcher: typeof fetch = fetch,
  back: () => void = returnToPairing,
): Promise<void> {
  try {
    const response = await fetcher(webPageUrl('api/session'), { credentials: 'same-origin', cache: 'no-store' })
    if (response.status === 401) back()
  } catch {
    // The server is not there: the reconnect keeps trying.
  }
}

/**
 * How a tab's connections behave: its Studio is another machine; a revoked
 * session goes back to pairing, whether the server said so (4401) or refused
 * the socket at its upgrade; and a reconnect says the server may have been
 * replaced, so the tab checks which bundle it serves (webBuildWatch.ts).
 */
export const WEB_STUDIO_SETUP: WindowStudioSetup = {
  anotherMachine: true,
  onSocketClose: (code, socket) => {
    if (code === WEB_CLOSE_REVOKED) returnToPairing()
    else if (!socket.opened) void checkStillPaired()
  },
  onReopen: () => window.dispatchEvent(new Event(WEB_STUDIO_REOPENED_EVENT)),
}
