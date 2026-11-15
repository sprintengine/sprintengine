import type { StudioWindowTicket } from '../../../shared/studio-connection'
import type { WindowStudioSetup } from '../studio/windowStudioClient'
import { returnToPairing, webSocketUrl } from './webLocation'
import { WEB_CLOSE_REVOKED } from './webReconnect'

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

/** How a tab's connections behave: its Studio is another machine, and a revoked session goes back to pairing. */
export const WEB_STUDIO_SETUP: WindowStudioSetup = {
  anotherMachine: true,
  onSocketClose: (code) => {
    if (code === WEB_CLOSE_REVOKED) returnToPairing()
  },
}
