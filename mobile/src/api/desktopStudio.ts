import {
  StudioError,
  connect,
  isStudioVersionFailure,
  presentStudioFailure,
  webSocketTransport,
  type StudioClient,
  type StudioClientState,
  type StudioWebSocketConstructor,
} from "../../../packages/client-runtime/src/public";
import type { StudioWelcomeFrame } from "../../../packages/studio-protocol/src/public";
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

/**
 * A paired desktop's Studio. The phone reaches only the desktop itself: an
 * SSH machine or a WSL distribution that desktop holds is reached from that
 * desktop alone.
 */
export type DesktopTarget = { baseUrl: string; deviceToken: string };

/** The Studio a session names: its desktop's. */
export function studioTargetOf(session: DesktopTarget): DesktopTarget {
  return { baseUrl: session.baseUrl, deviceToken: session.deviceToken };
}

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
/** Who wants to hear how a desktop's connection stands, by desktop and pairing. */
const stateListeners = new Map<string, Set<(state: StudioClientState, error?: StudioError) => void>>();
/** What each desktop's Studio last said it serves this pairing: its welcome. */
const welcomes = new Map<string, StudioWelcomeFrame>();
const welcomeListeners = new Map<string, Set<() => void>>();

function heard(key: string, welcome: StudioWelcomeFrame): void {
  if (welcomes.get(key) === welcome) return;
  welcomes.set(key, welcome);
  for (const listener of [...(welcomeListeners.get(key) ?? [])]) listener();
}

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
  let connected: StudioClient | null = null;
  const opening = connect({
    client: { name: "SprintEngine Studio phone" },
    onStateChange: (state, error) => {
      // Each connection's welcome says again what this pairing may use there.
      if (state === "open" && connected) heard(key, connected.welcome);
      for (const listener of [...(stateListeners.get(key) ?? [])]) listener(state, error);
    },
    transport: webSocketTransport({
      ticket: () => mintTicket(target, fetchImpl),
      WebSocket: options.WebSocket ?? noOriginWebSocket,
    }),
  });
  clients.set(key, opening);
  opening.then(
    (client) => {
      connected = client;
      heard(key, client.welcome);
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

function listen<T>(table: Map<string, Set<T>>, key: string, listener: T): () => void {
  const listeners = table.get(key) ?? new Set<T>();
  table.set(key, listeners);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && table.get(key) === listeners) table.delete(key);
  };
}

/**
 * Hear each change in how this desktop's connection stands (`open`,
 * `reconnecting`, `parked` with why, `closed`), while the returned stop is
 * not called.
 */
export function watchDesktopStudio(
  target: DesktopTarget,
  listener: (state: StudioClientState, error?: StudioError) => void,
): () => void {
  return listen(stateListeners, clientKey(target), listener);
}

/**
 * Hear each time this desktop's connection is back after a drop, while the
 * returned stop is not called. Nothing said on a push topic while it was down
 * is replayed, so a follower reads again here.
 */
export function onDesktopStudioBack(target: DesktopTarget, listener: () => void): () => void {
  let down = false;
  return watchDesktopStudio(target, (state) => {
    if (state !== "open") {
      down = true;
      return;
    }
    if (!down) return;
    down = false;
    listener();
  });
}

/**
 * What this desktop's Studio last said it serves this pairing (its welcome:
 * its capabilities, its chats' and the grant), or null before it has said
 * anything in this run of the app. What the phone offers is read from here,
 * never from what the desktop said at pairing time.
 */
export function desktopWelcome(target: DesktopTarget): StudioWelcomeFrame | null {
  return welcomes.get(clientKey(target)) ?? null;
}

/** Hear each new welcome from this desktop, while the returned stop is not called. */
export function onDesktopWelcome(target: DesktopTarget, listener: () => void): () => void {
  return listen(welcomeListeners, clientKey(target), listener);
}

/** Close every desktop's connection: the phone unpaired, or a test is done. */
export function closeDesktopStudios(): void {
  const open = [...clients.values()];
  clients.clear();
  welcomes.clear();
  for (const opening of open) opening.then((client) => client.close(), () => undefined);
}

/**
 * A failed ask, in the phone's words for what went wrong: read by the shared
 * runtime (`presentStudioFailure`), so a version refusal names which side to
 * update, the desktop or this app.
 */
export function studioFailure(error: unknown): { errorCode: ApiErrorCode; message: string; code: string | null } {
  const code = error instanceof StudioError ? error.code : null;
  const failure = presentStudioFailure(error);
  const message =
    isStudioVersionFailure(failure.kind) || (error instanceof Error && error.message) ? failure.message : "The desktop could not answer.";
  switch (failure.kind) {
    case "server-outdated":
      // A desktop whose Studio predates what was asked: said about the desktop.
      return { errorCode: "command_not_supported", message: code === "unsupported_protocol_version" ? message : DESKTOP_STUDIO_OUTDATED, code };
    case "client-outdated":
    case "incompatible":
      return { errorCode: "command_not_supported", message, code };
    case "unauthorized":
      return { errorCode: "unauthenticated", message, code };
    case "forbidden":
      return { errorCode: "unauthorized", message, code };
    default:
      return { errorCode: code === "not_found" || code === "invalid_params" ? "invalid_payload" : "desktop_unavailable", message, code };
  }
}
