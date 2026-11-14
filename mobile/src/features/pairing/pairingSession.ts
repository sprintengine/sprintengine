import type { TailnetPairingCompletion } from "../../api/tailnetControlClient";
import type { MobileSession } from "../../api/types";

import { type TailnetPairingPayload } from "./pairingPayload";

/** The stored session for a completed tailnet pairing. */
export function createMobileSessionFromTailnetPairing(input: {
  tailnet: TailnetPairingPayload;
  completion: TailnetPairingCompletion;
  pairedAt: string;
}): MobileSession {
  const host = new URL(input.tailnet.baseUrl).hostname;
  return {
    deviceId: input.completion.deviceId,
    desktopName: `Desktop on ${host}`,
    baseUrl: input.tailnet.baseUrl,
    deviceToken: input.completion.deviceToken,
    pairedAt: input.pairedAt,
    lastSeenAt: input.pairedAt,
    status: "online",
    tailnetScopes: [...input.completion.scopes],
    // Only what the gateway said: an absence keeps reading as "not declared", not as version 0.
    ...(input.completion.transport.transportVersion !== null ? { tailnetTransportVersion: input.completion.transport.transportVersion } : {}),
  };
}
