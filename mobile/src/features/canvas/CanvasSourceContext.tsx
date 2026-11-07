import { createContext, useContext } from "react";

import { createCanvasBoardsApi, type CanvasBoardsApi } from "../../api/canvasBoards";
import {
  createConversation,
  type CreateConversationInput,
  type CreateConversationResult,
} from "../../api/conversationLaunch";
import { createTailnetWorkspacesApi, type WorkspacesApi } from "../../api/tailnetWorkspaces";
import type { MobileSession } from "../../api/types";

/**
 * Where the Canvases screens get each desktop's boards, its projects, and a
 * new chat from: the gateway, unless the screenshot harness hands in a
 * fixture desktop of the same shape.
 */
export interface CanvasSource {
  boards(session: MobileSession): CanvasBoardsApi;
  workspaces(session: MobileSession): WorkspacesApi;
  startChat(session: MobileSession, input: CreateConversationInput): Promise<CreateConversationResult>;
}

const gatewayCanvasSource: CanvasSource = {
  boards: (session) => createCanvasBoardsApi({ baseUrl: session.baseUrl, deviceToken: session.deviceToken }),
  workspaces: (session) => createTailnetWorkspacesApi({ baseUrl: session.baseUrl, deviceToken: session.deviceToken }),
  startChat: (session, input) =>
    createConversation(
      { baseUrl: session.baseUrl, deviceToken: session.deviceToken, machineName: session.desktopName },
      input,
    ),
};

export const CanvasSourceContext = createContext<CanvasSource>(gatewayCanvasSource);

export function useCanvasSource(): CanvasSource {
  return useContext(CanvasSourceContext);
}
