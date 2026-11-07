import { useMemo } from "react";

import type { ConversationThread } from "../../api/conversationWire";
import type { MobileSession } from "../../api/types";
import type { HomeStackParamList } from "../../navigation/types";
import { canvasTargetFromParams } from "./canvasLogic";
import { CanvasBoardScreen } from "./CanvasBoardScreen";

/**
 * The CanvasBoard route: its flat params read back as the board once per
 * route, so the picture is asked for once and not on every render.
 */
export function CanvasBoardRoute({
  params,
  sessions,
  onBack,
  onStarted,
}: {
  params: HomeStackParamList["CanvasBoard"];
  sessions: MobileSession[];
  onBack: () => void;
  onStarted: (deviceId: string, thread: ConversationThread) => void;
}) {
  const target = useMemo(() => canvasTargetFromParams(params), [params]);
  const found = sessions.find((candidate) => candidate.deviceId === target.deviceId) ?? null;
  // The same desktop from one session read to the next: a status or a
  // last-seen stamp moving is no reason to draw the board again over there.
  const reach = found
    ? [found.baseUrl, found.deviceToken, found.desktopName, ...found.tailnetScopes, ...(found.tailnetCapabilities ?? [])].join("\u0000")
    : "";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const session = useMemo(() => found, [reach]);
  return <CanvasBoardScreen key={JSON.stringify(target)} onBack={onBack} onStarted={onStarted} session={session} target={target} />;
}
