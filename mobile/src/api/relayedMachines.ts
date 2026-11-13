import { STUDIO_RELAYED_ENVIRONMENTS_CAPABILITY } from "../../../packages/studio-protocol/src/handshake";
import {
  relayedEnvironmentsOf,
  type StudioRelayedEnvironment,
} from "../../../packages/studio-protocol/src/environment-access";
import { desktopStudio, studioTargetOf, type DesktopStudioOptions } from "./desktopStudio";
import type { MobileSession } from "./types";

// The machines a paired desktop relays this phone to (design-wsl-ssh-direct):
// the SSH machines it holds, whose chats are those machines' own. Each is
// reached at `/tailnet/v1/environments/<id>/studio` on that desktop's tailnet
// listener with this pairing's device token, and admits the phone itself, as
// this pairing's device with its grant there cut to what a relayed device may
// hold, never an owner's. The phone files each as a session of its own,
// derived from the desktop's and never stored: its chats sit in the same
// list, under the machine's name and mark, and every screen that asks a
// session's Studio asks the machine's (`studioTargetOf`).

/** A machine a desktop relays this phone to, as a session: never stored, gone when the desktop stops listing it. */
export function relayedSession(
  desktop: MobileSession,
  machine: Omit<StudioRelayedEnvironment, "machine">,
): MobileSession {
  const { machineMark: _desktopMark, ...rest } = desktop;
  return {
    ...rest,
    deviceId: `${desktop.deviceId}~${machine.environmentId}`,
    desktopName: machine.name,
    environmentId: machine.environmentId,
    relayedEnvironmentId: machine.environmentId,
    relayedVia: desktop.deviceId,
    ...(machine.mark ? { machineMark: { kind: machine.mark.kind, color: machine.mark.color } } : {}),
    status: desktop.status === "revoked" ? "revoked" : machine.connected ? desktop.status : "offline",
  };
}

/**
 * The machines this desktop relays the phone to, as sessions: none from a
 * desktop that does not list them (an older Studio, or one that relays none),
 * from a revoked pairing, or when the desktop cannot be reached.
 */
export async function relayedSessions(
  desktop: MobileSession,
  options: DesktopStudioOptions = {},
): Promise<MobileSession[]> {
  if (desktop.status === "revoked" || desktop.relayedEnvironmentId) return [];
  try {
    const client = await desktopStudio(studioTargetOf(desktop), options);
    if (!client.supports(STUDIO_RELAYED_ENVIRONMENTS_CAPABILITY)) return [];
    // Read through the protocol's own reader: each id becomes a ticket's body and a socket path.
    const answer = await client.request("environment.relayed", {});
    return relayedEnvironmentsOf(answer).map((machine) => relayedSession(desktop, machine));
  } catch {
    return [];
  }
}
