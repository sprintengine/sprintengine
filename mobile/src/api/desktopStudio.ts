import {
  StudioError,
  connect,
  webSocketTransport,
  type StudioClient,
  type StudioWebSocketConstructor,
} from "../../../packages/client-runtime/src/public";
import type { ApiErrorCode } from "./types";
import { readPeerRefusal } from "./tailnetTransport";

// The phone's one connection to a paired desktop's Studio: the Studio protocol
// every client speaks, on the desktop's tailnet listener at `/tailnet/v1/studio`,
// through the shared client runtime (its socket client, its reconnects, its
// resume by cursor). One socket per desktop, shared by every screen that asks
// it something; it reconnects by itself and is dropped once it closes for good.
//
// Each connection is opened with a ticket the device token buys, good once for
// thirty seconds; its hello presents the same ticket. The token never rides a
// URL. React Native's WebSocket names an Origin of its own unless told not to,
// and the desktop refuses any socket that says one but a desktop window's, so
// this one says none.
//
// What this phone may ask is its pairing's grant, read by the desktop at every
// request: a narrowed pairing is refused `scope_required`, a removed one closes
// the connection.

const TICKET_PATH = "/tailnet/v1/ws-ticket";
const TICKET_TIMEOUT_MS = 10_000;

export type DesktopTarget = { baseUrl: string; deviceToken: string };

type NativeSocket = new (
  url: string,
  protocols: string | string[] | undefined,
  options: { headers: Record<string, string> },
) => unknown;

/** The platform's WebSocket, saying no Origin. */
const noOriginWebSocket = class {
  constructor(url: string) {
    return new (globalThis.WebSocket as unknown as NativeSocket)(url, undefined, { headers: { origin: "" } }) as never;
  }
} as unknown as StudioWebSocketConstructor;

export type DesktopStudioOptions = {
  fetchImpl?: typeof fetch;
  WebSocket?: StudioWebSocketConstructor;
};

/** The words a desktop from before the Studio protocol earns. */
export const DESKTOP_STUDIO_OUTDATED = "Update SprintEngine Studio on the desktop to use this from the phone.";

/**
 * A ticket for one connection, refused in the runtime's terms: `unauthorized`
 * for a pairing the desktop no longer knows (nothing to retry), `outdated` for
 * a desktop from before the protocol, `unavailable` for one that did not answer.
 */
async function mintTicket(target: DesktopTarget, fetchImpl: typeof fetch): Promise<{ url: string; token: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TICKET_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(`${target.baseUrl}${TICKET_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${target.deviceToken}`, "content-type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
  } catch {
    throw new StudioError("unavailable", "The desktop did not answer. Is Tailscale up on both devices?");
  } finally {
    clearTimeout(timer);
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.status === 401) {
    const refusal = readPeerRefusal(401, body);
    // Refused over the tailnet node, not the token: whois could not place this
    // phone for a moment (try again), or knows the pairing from another node.
    if (refusal?.code === "peer_unverified") throw new StudioError("unavailable", refusal.message);
    if (refusal) throw new StudioError("peer_mismatch", refusal.message);
    throw new StudioError("unauthorized", "This phone is no longer paired with the desktop.");
  }
  if (!response.ok || !body || typeof body.ticket !== "string")
    throw new StudioError("unavailable", `The desktop answered ${response.status}.`);
  if (typeof body.studioPath !== "string") throw new StudioError("outdated", DESKTOP_STUDIO_OUTDATED);
  const socketBase = target.baseUrl.replace(/^http(s?):/u, "ws$1:");
  return { url: `${socketBase}${body.studioPath}?ticket=${encodeURIComponent(body.ticket)}`, token: body.ticket };
}

const clients = new Map<string, Promise<StudioClient>>();
/** Who wants to hear that a desktop's connection is back after a drop, by desktop and pairing. */
const backListeners = new Map<string, Set<() => void>>();

function clientKey(target: DesktopTarget): string {
  return `${target.baseUrl}\n${target.deviceToken}`;
}

/**
 * The desktop's Studio client, connecting on the first ask. Shared per desktop
 * and pairing; a connection that fails, or closes for good, is forgotten, so
 * the next ask connects again.
 */
export function desktopStudio(target: DesktopTarget, options: DesktopStudioOptions = {}): Promise<StudioClient> {
  const key = clientKey(target);
  const held = clients.get(key);
  if (held) return held;
  const fetchImpl = options.fetchImpl ?? fetch;
  // A push stream replays nothing of what was said while the socket was down,
  // so whoever follows one is told when it is back, to read again.
  let down = false;
  const opening = connect({
    client: { name: "SprintEngine Studio phone" },
    onStateChange: (state) => {
      if (state !== "open") {
        down = true;
        return;
      }
      if (!down) return;
      down = false;
      for (const listener of [...(backListeners.get(key) ?? [])]) listener();
    },
    transport: webSocketTransport({
      ticket: () => mintTicket(target, fetchImpl),
      WebSocket: options.WebSocket ?? noOriginWebSocket,
    }),
  });
  clients.set(key, opening);
  opening.then(
    (client) => {
      const forget = () => {
        if (clients.get(key) === opening) clients.delete(key);
      };
      client.closed.then(forget, forget);
    },
    () => {
      if (clients.get(key) === opening) clients.delete(key);
    },
  );
  return opening;
}

/**
 * Hear each time this desktop's connection is back after a drop, while the
 * returned stop is not called. Nothing said on a push topic while it was down
 * is replayed, so a follower reads again here.
 */
export function onDesktopStudioBack(target: DesktopTarget, listener: () => void): () => void {
  const key = clientKey(target);
  const listeners = backListeners.get(key) ?? new Set<() => void>();
  backListeners.set(key, listeners);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && backListeners.get(key) === listeners) backListeners.delete(key);
  };
}

/** Close every desktop's connection: the phone unpaired, or a test is done. */
export function closeDesktopStudios(): void {
  const open = [...clients.values()];
  clients.clear();
  for (const opening of open) opening.then((client) => client.close(), () => undefined);
}

/** A failed ask, in the phone's words for what went wrong. */
export function studioFailure(error: unknown): { errorCode: ApiErrorCode; message: string; code: string | null } {
  const code = error instanceof StudioError ? error.code : null;
  const message = error instanceof Error && error.message ? error.message : "The desktop could not answer.";
  switch (code) {
    case "unauthorized":
    case "revoked":
    case "peer_mismatch":
      return { errorCode: "unauthenticated", message, code };
    case "scope_required":
    case "owner_required":
      return { errorCode: "unauthorized", message, code };
    case "outdated":
    case "unknown_method":
      return { errorCode: "command_not_supported", message: DESKTOP_STUDIO_OUTDATED, code };
    case "not_found":
    case "invalid_params":
      return { errorCode: "invalid_payload", message, code };
    default:
      return { errorCode: "desktop_unavailable", message, code };
  }
}
