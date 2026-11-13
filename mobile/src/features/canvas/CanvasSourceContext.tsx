import { createContext, useContext } from "react";

import { createCanvasBoardsApi, type CanvasBoardsApi } from "../../api/canvasBoards";
import {
  createConversation,
  type CreateConversationInput,
  type CreateConversationResult,
} from "../../api/conversationLaunch";
import type { MobileSession } from "../../api/types";
import { studioTargetOf } from "../../api/desktopStudio";

/**
 * Where the Canvases screens get each desktop's boards and a new chat from:
 * the desktop's Studio, unless the screenshot harness hands in a fixture
 * desktop of the same shape.
 */
export interface CanvasSource {
  boards(session: MobileSession): CanvasBoardsApi;
  startChat(session: MobileSession, input: CreateConversationInput): Promise<CreateConversationResult>;
}

const desktopCanvasSource: CanvasSource = {
  boards: (session) => createCanvasBoardsApi(studioTargetOf(session)),
  startChat: (session, input) =>
    createConversation({ ...studioTargetOf(session), machineName: session.desktopName }, input),
};

export const CanvasSourceContext = createContext<CanvasSource>(desktopCanvasSource);

export function useCanvasSource(): CanvasSource {
  return useContext(CanvasSourceContext);
}
