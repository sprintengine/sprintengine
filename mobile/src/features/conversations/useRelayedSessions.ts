import { useEffect, useState } from "react";
import { AppState } from "react-native";

import { relayedSessions } from "../../api/relayedMachines";
import type { MobileSession } from "../../api/types";

/** How often the machines each desktop relays are read again while the app is in front. */
const REREAD_MS = 60_000;

/**
 * The machines the paired desktops relay this phone to, as sessions of their
 * own (`relayedMachines.ts`): read when the paired desktops change, when the
 * app comes back to the front, and every minute while it is there.
 */
export function useRelayedSessions(sessions: readonly MobileSession[]): MobileSession[] {
  const [relayed, setRelayed] = useState<MobileSession[]>([]);
  useEffect(() => {
    let current = true;
    const read = () => {
      void Promise.all(sessions.map((session) => relayedSessions(session))).then((lists) => {
        if (!current) return;
        const next = lists.flat();
        setRelayed((before) => (JSON.stringify(before) === JSON.stringify(next) ? before : next));
      });
    };
    read();
    const timer = setInterval(() => {
      if (AppState.currentState === "active") read();
    }, REREAD_MS);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") read();
    });
    return () => {
      current = false;
      clearInterval(timer);
      subscription.remove();
    };
  }, [sessions]);
  return relayed;
}
