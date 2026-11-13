import { createContext, useContext } from "react";

import { createCanvasBoardsApi, type CanvasBoardsApi } from "../../api/canvasBoards";
import {
  createConversation,
  type CreateConversationInput,
  type CreateConversationResult,
} from "../../api/conversationLaunch";
import type { MobileSession } from "../../api/types";

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
  boards: (session) => createCanvasBoardsApi({ baseUrl: session.baseUrl, deviceToken: session.deviceToken }),
  startChat: (session, input) =>
    createConversation(
      { baseUrl: session.baseUrl, deviceToken: session.deviceToken, machineName: session.desktopName },
      input,
    ),
};

export const CanvasSourceContext = createContext<CanvasSource>(desktopCanvasSource);

export function useCanvasSource(): CanvasSource {
  return useContext(CanvasSourceContext);
}
