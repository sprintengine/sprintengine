import { isLinkId } from "../../../packages/studio-protocol/src/chat-link";
import { readPeerRefusal, readTransportDeclaration, type TailnetTransportDeclaration } from "./tailnetTransport";
import type { ApiResult, DesktopMachineMark } from "./types";

// Pairing with a desktop's tailnet gateway, and what the gateway says of the
// pairing after: plain fetch + JSON, no account and no server in between.
// `POST /tailnet/v1/pair` once, then `GET /tailnet/v1/identity` on
// foreground. Everything the phone asks a desktop after pairing goes over the
// desktop's Studio protocol (desktopStudio.ts). Never send an Origin header:
// the gateway refuses any request carrying one (React Native's native fetch
// sends none).

const TAILNET_PAIR_PATH = "/tailnet/v1/pair";
const TAILNET_IDENTITY_PATH = "/tailnet/v1/identity";
const READ_TIMEOUT_MS = 10_000;

/**
 * The session with the grant the desktop holds for it now, or null when that
 * is the one already held (or the identity said none). A grant widened on the
 * desktop unlocks the phone's controls without pairing again, and a narrowed
 * one takes away controls the desktop would refuse.
 */
export function withTailnetScopes<T extends { tailnetScopes: string[] }>(session: T, scopes: readonly string[] | null): T | null {
  if (!scopes) return null;
  const held = new Set(session.tailnetScopes);
  if (scopes.length === held.size && scopes.every((scope) => held.has(scope))) return null;
  return { ...session, tailnetScopes: [...new Set(scopes)] };
}

export interface TailnetPairingCompletion {
  deviceId: string;
  deviceName: string;
  deviceToken: string;
  scopes: string[];
  /** What the gateway said it speaks, if it said (a version-1 Studio says nothing here). */
  transport: TailnetTransportDeclaration;
}

export async function completeTailnetPairing(input: {
  baseUrl: string;
  pairingToken: string;
  deviceName: string;
}): Promise<ApiResult<TailnetPairingCompletion>> {
  let response: Response;
  try {
    response = await fetchWithTimeout(`${input.baseUrl}${TAILNET_PAIR_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingToken: input.pairingToken, deviceName: input.deviceName }),
    });
  } catch {
    return {
      ok: false,
      errorCode: "desktop_unavailable",
      message: "The desktop's tailnet gateway is unreachable. Is Tailscale up on both devices, and remote control enabled on the desktop?",
    };
  }

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    // The gateway refuses as { error: { code, message } } (older shapes may be
    // a bare string) — surface its own reason when it gives one.
    const gatewayError = isRecord(body?.error)
      ? (typeof body.error.message === "string" && body.error.message) ||
        (typeof body.error.code === "string" && body.error.code) ||
        null
      : typeof body?.error === "string"
        ? body.error
        : null;
    return {
      ok: false,
      errorCode: response.status === 400 ? "invalid_payload" : "unauthenticated",
      message: gatewayError
        ? `The desktop refused the pairing: ${gatewayError}.`
        : "The desktop refused the pairing code. Codes are single-use and expire — generate a fresh one from the desktop.",
    };
  }
  if (
    !body ||
    typeof body.deviceId !== "string" ||
    typeof body.deviceName !== "string" ||
    typeof body.deviceToken !== "string" ||
    !Array.isArray(body.scopes) ||
    body.scopes.some((scope) => typeof scope !== "string")
  ) {
    return { ok: false, errorCode: "invalid_payload", message: "The desktop returned an invalid pairing response." };
  }
  return {
    ok: true,
    data: {
      deviceId: body.deviceId,
      deviceName: body.deviceName,
      deviceToken: body.deviceToken,
      scopes: body.scopes as string[],
      transport: readTransportDeclaration(body),
    },
  };
}

/**
 * `GET /tailnet/v1/identity`: what the gateway says about this pairing and
 * itself, of which the phone keeps the grant, the transport declaration, the
 * machine mark and the Studio's environment id. Read on foreground because a Studio
 * updates under a standing pairing, and its grant can be widened or narrowed
 * there, so the pair-time answer goes stale. One cheap GET; a 401 is the
 * pairing being gone, which the caller already knows how to say. `scopes` is
 * null when the answer carries none, which says nothing about the grant;
 * `environmentId` is null from a Studio that says none (or one no link can
 * carry).
 */
export async function readTailnetIdentity(input: {
  baseUrl: string;
  deviceToken: string;
}): Promise<
  ApiResult<{
    scopes: string[] | null;
    transport: TailnetTransportDeclaration;
    machine: DesktopMachineMark | null;
    environmentId: string | null;
  }>
> {
  let response: Response;
  try {
    response = await fetchWithTimeout(`${input.baseUrl}${TAILNET_IDENTITY_PATH}`, {
      method: "GET",
      headers: { authorization: `Bearer ${input.deviceToken}` },
    });
  } catch {
    return { ok: false, errorCode: "desktop_unavailable", message: "The desktop did not answer." };
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.status === 401) return unauthorizedResult(body);
  if (!response.ok || !body) {
    return { ok: false, errorCode: "desktop_unavailable", message: `The desktop answered ${response.status}.` };
  }
  const scopes = Array.isArray(body.scopes) ? body.scopes.filter((scope): scope is string => typeof scope === "string") : null;
  return {
    ok: true,
    data: {
      scopes,
      transport: readTransportDeclaration(body),
      machine: readIdentityMachine(body.machine),
      environmentId: isLinkId(body.environmentId) ? body.environmentId : null,
    },
  };
}

/**
 * The identity's `machine`: how the desktop draws itself, kind and colour as
 * strings. Kept as sent, and read into a known kind and colour where it is
 * drawn (`readMachineMark`), so a kind this build has never heard of still
 * marks the desktop. Null when absent or not in that shape.
 */
export function readIdentityMachine(value: unknown): DesktopMachineMark | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { kind, color } = value as Record<string, unknown>;
  if (typeof kind !== "string" || typeof color !== "string") return null;
  return { kind, color };
}

/**
 * What a 401 from the gateway means. A token the desktop no longer knows is
 * an unpairing. A token refused over the node presenting it is not: whois
 * failing for a moment is the desktop being briefly unable to answer, and a
 * token held to another node is a pairing to make again, with its own words.
 */
export function unauthorizedResult(body: unknown): ApiResult<never> {
  const refusal = readPeerRefusal(401, body);
  if (refusal?.code === "peer_unverified") return { ok: false, errorCode: "desktop_unavailable", message: refusal.message };
  if (refusal) return { ok: false, errorCode: "unauthenticated", message: refusal.message };
  return { ok: false, errorCode: "unauthenticated", message: "This device is no longer paired with the desktop." };
}

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number = READ_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
