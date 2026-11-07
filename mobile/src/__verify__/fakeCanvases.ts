import type { CanvasBoardsApi } from "../api/canvasBoards";
import { readCanvasBoards } from "../api/canvasBoards";
import type { MobileSession } from "../api/types";
import type { CanvasSource } from "../features/canvas/CanvasSourceContext";
import { fakeWorkspacesApi } from "./fakeWorkspaces";
import { verifyConversation } from "./fakeConversations";

// A fake of the gateway's canvas tools for the screenshot harness, in the
// shapes `canvas.list` and `canvas.screenshot` answer, read through the app's
// own parse. Never bundled into the app (see index.js / App.tsx).
//
// The harness desktop advertises `canvas-machine-boards`, so it lists every
// board there in one answer: two projects' boards, one of them a pooled
// worktree's, and a board whose project was removed ("Deleted project"). The
// Mac mini is an older Studio: it is asked one project at a time and says so.
// Its third project answers with a refusal, to photograph the words for one.
// A board's picture is a small drawn diagram in each theme.
//
//   sprintengine://verify/canvases
//   sprintengine://verify/canvas/dev_verify/export-flow?path=export-flow.excalidraw&project=mobile&id=canvas%3A%2F%2Fws_aaaaaaaaaaaaaaaaaaaaaaaa%2Fexport-flow.excalidraw&workspaceId=ws-mobile
//   sprintengine://verify/canvas/dev_verify/old-sketch?path=old-sketch.excalidraw&id=canvas%3A%2F%2Fws_cccccccccccccccccccccccc%2Fold-sketch.excalidraw
//   sprintengine://verify/canvas/dev_verify/missing?path=missing.excalidraw&workspaceId=ws-mobile   (refused)

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const STORE_MOBILE = "ws_aaaaaaaaaaaaaaaaaaaaaaaa";
const STORE_STUDIO = "ws_bbbbbbbbbbbbbbbbbbbbbbbb";
const STORE_GONE = "ws_cccccccccccccccccccccccc";

const MACHINE_ANSWER = {
  scope: "machine",
  boards: [
    { id: `canvas://${STORE_MOBILE}/export-flow.excalidraw`, path: "export-flow.excalidraw", name: "export-flow", project: "mobile", here: false, workspaceId: "ws-mobile", elementCount: 14, modifiedAt: minutesAgo(12) },
    { id: `canvas://${STORE_STUDIO}/pairing.excalidraw`, path: "pairing.excalidraw", name: "pairing", project: "multicode", here: false, workspaceId: "ws-studio", elementCount: 31, modifiedAt: minutesAgo(60 * 5) },
    { id: `canvas://${STORE_STUDIO}/diagrams/architecture.excalidraw`, path: "diagrams/architecture.excalidraw", name: "architecture", project: "multicode", here: false, workspaceId: "ws-studio", elementCount: 52, modifiedAt: minutesAgo(60 * 30) },
    { id: `canvas://${STORE_GONE}/old-sketch.excalidraw`, path: "old-sketch.excalidraw", name: "old-sketch", project: null, here: false, workspaceId: null, elementCount: 0, modifiedAt: minutesAgo(60 * 24 * 9) },
  ],
};

const MINI_PROJECTS: Record<string, { boards: unknown[] } | null> = {
  "ws-mobile": { boards: [{ path: "onboarding.excalidraw", name: "onboarding", elementCount: 8, modifiedAt: minutesAgo(60 * 3) }] },
  "ws-studio": null,
};

const PICTURE_LIGHT =
  "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" +
  "31cAAAAASUVORK5CYII=";
const PICTURE_DARK =
  "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" +
  "MAAAAABJRU5ErkJggg==";

function boardsOf(session: MobileSession): CanvasBoardsApi {
  const older = !(session.tailnetCapabilities ?? []).includes("canvas-machine-boards");
  return {
    async listMachine() {
      return { ok: true, data: readCanvasBoards(MACHINE_ANSWER, null) };
    },
    async listProject(project) {
      const answer = older ? MINI_PROJECTS[project.workspaceId] : { boards: MACHINE_ANSWER.boards.filter((board) => board.workspaceId === project.workspaceId) };
      return answer
        ? { ok: true, data: readCanvasBoards(answer, project) }
        : { ok: false, message: "The Canvas module is disabled. Enable it in Settings → Modules to use canvas tools.", code: "canvas_module_disabled", errorCode: "invalid_payload" };
    },
    async picture(input) {
      if (/missing/u.test(input.board)) {
        return {
          ok: false,
          message: "There is no board at missing.excalidraw yet. canvas.open creates it and shows it to the person, or canvas.edit creates it with your first shapes.",
          code: "not_found",
          errorCode: "invalid_payload",
        };
      }
      const data = input.dark ? PICTURE_DARK : PICTURE_LIGHT;
      return { ok: true, data: { uri: `data:image/png;base64,${data}`, width: 720, height: 420 } };
    },
  };
}

export const fakeCanvasSource: CanvasSource = {
  boards: boardsOf,
  workspaces: () => fakeWorkspacesApi,
  // Continue in a new chat opens the harness's own chat, as a started one would.
  async startChat() {
    return {
      ok: true,
      conversation: {
        workspaceId: verifyConversation.workspaceId,
        agentId: verifyConversation.agentId,
        name: verifyConversation.title,
        cli: "claude-code",
        providerId: verifyConversation.providerId,
        modelId: verifyConversation.modelId,
        sessionId: "",
      },
    };
  },
};
