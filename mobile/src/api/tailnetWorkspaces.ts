import { unauthorizedResult } from "./tailnetControlClient";
import type { ApiResult } from "./types";
import { desktopStudio, studioFailure, type DesktopStudioOptions } from "./desktopStudio";
import type { StudioClient } from "../../../packages/client-runtime/src/public";
import { readCliRuntimes, type CliRuntime } from "../features/conversations/launchLogic";
import { isProjectHue } from "../theme/projectHue";
import { comparablePath, lastPathSegment, workspaceProject } from "../features/projects/worktreeProjectLogic";

// The phone's reads of what a desktop holds, before and beside a chat: the
// projects it has open (`workspaces.list`: the chat's project pill, and step
// one of New), the CLIs and models New may offer (`cliRuntimes.list`), and a
// project's checkout (`workspaces.checkout`). Asked over the desktop's Studio
// protocol (desktopStudio.ts), which answers them from the same services its
// gateway tools do.
//
// The gateway tool caller below stays for the families that have not moved onto
// the protocol yet (a chat's lifecycle, schedules, boards): JSON-RPC tools over
// a stateless POST, with no Origin header.

const TAILNET_MCP_PATH = "/tailnet/v1/mcp";
const READ_TIMEOUT_MS = 10_000;

/** One project the desktop has open, as `workspace.list` reports it. */
export interface DesktopWorkspace {
  workspaceId: string;
  /** The desktop's display name for the workspace ("Chat", "acme-app"). */
  name: string;
  /**
   * The last segment of the project's folder, which is what a person calls
   * the project: for a chat in one of the project's worktrees, the project's
   * name ("multicode"), not the worktree's ("pool-02").
   */
  projectName: string;
  folderPath: string | null;
  /** The project's own folder: the folder itself, or the checkout its worktree was cut from. */
  projectFolder?: string | null;
  /** The worktree's name when the folder is one of the project's worktrees; null or absent otherwise. */
  worktree?: string | null;
  /**
   * A chat started without a project, in a folder of its own under the
   * desktop's "No project" root: it lists as "No project", in no colour, as
   * the desktop's sidebar files it. Absent or false otherwise.
   */
  projectless?: boolean;
  /**
   * What makes two workspaces one project: the repository's canonical key when
   * the desktop knows one (every clone and worktree of a repo shares it), else
   * the project's folder. Null for a workspace with no folder, which is not a
   * project.
   */
  projectKey: string | null;
  /**
   * The project's hue when the desktop sends one on this list. Read, never
   * derived: the desktop owns the hash (see theme/projectHue.ts).
   */
  projectHue: number | null;
  /**
   * How much the desktop has used this folder's project for new chats, its
   * own and this phone's (`projectFrecency` on the list): New lists the
   * projects by it. Absent from a desktop that does not send it.
   */
  projectFrecency?: number;
  /** The desktop's latest new chat in the folder, epoch ms; null for never. Absent when not sent. */
  projectLastUsedAt?: number | null;
  /**
   * When the chat was settled on the desktop, from a desktop that advertises
   * `conversation-lifecycle`; null or absent when it is not. Such a desktop
   * leaves settled chats off its chat list already; the phone drops them as
   * well, so a list read a moment apart from this one cannot bring one back.
   */
  settledAt?: number | null;
}

/**
 * Where a workspace's folder stands in git, as New's context strip says it:
 * the branch it is on, and the worktree's name when the folder is one rather
 * than the repository's main checkout. Read-only: the phone does not make or
 * switch either.
 */
export interface WorkspaceCheckout {
  branch: string | null;
  worktree: string | null;
  /**
   * The branch the repository's main checkout is on: what New's worktree is
   * cut from ("from main"), whichever of the repository's folders the
   * project was asked about through. Null where the answer lists no main
   * worktree.
   */
  mainBranch: string | null;
}

/** What a screen needs from the gateway; the harness supplies a fake of the same shape. */
export interface WorkspacesApi {
  /** The CLIs this desktop holds and the models each declares — never a guessed id. */
  listCliRuntimes(): Promise<ApiResult<CliRuntime[]>>;
  /** The projects this desktop has open: the chat's project pill, and step one of New. */
  listWorkspaces(): Promise<ApiResult<DesktopWorkspace[]>>;
  /**
   * The workspace's checkout, from `workspace.checkout` (`workspace:read`).
   * Null data for a folder that is not a git repository.
   */
  readCheckout(workspace: { workspaceId: string; folderPath: string | null }): Promise<ApiResult<WorkspaceCheckout | null>>;
}

/**
 * `workspace.checkout`'s answer as the strip needs it, or null for a folder
 * that is not a repository. The folder is a worktree when the repository lists
 * it as one of its worktrees and not as the main one; its name is the
 * folder's own. Every field is read fail-soft: a branch that is not a string
 * is no branch.
 */
export function readWorkspaceCheckout(data: unknown, folderPath: string | null): WorkspaceCheckout | null {
  if (!isRecord(data) || data.git !== true) return null;
  const branch = typeof data.branch === "string" && data.branch.trim() ? data.branch.trim() : null;
  const folder = folderPath ? comparablePath(folderPath) : null;
  const worktrees = Array.isArray(data.worktrees) ? data.worktrees : [];
  const own = folder
    ? worktrees.find(
        (entry) => isRecord(entry) && typeof entry.path === "string" && comparablePath(entry.path) === folder,
      )
    : undefined;
  const worktree = own && isRecord(own) && own.isMain !== true ? lastPathSegment(String(own.path)) : null;
  const main = worktrees.find((entry) => isRecord(entry) && entry.isMain === true);
  const mainBranch =
    isRecord(main) && typeof main.branch === "string" && main.branch.trim()
      ? main.branch.trim()
      : worktree === null
        ? branch
        : null;
  return { branch, worktree, mainBranch };
}

/**
 * One gateway tool's whole answer: its structured content, and the content
 * blocks beside it, which is where a picture rides (`canvas.screenshot`). A
 * refusal keeps the tool's own `code` where it gave one, and `unknown_tool`
 * for a desktop that has no such tool (an older Studio, or a server with no
 * desktop open), so a caller can say what to do rather than pass on the
 * gateway's sentence.
 */
export type GatewayToolAnswer =
  | { ok: true; structured: Record<string, unknown>; content: Record<string, unknown>[] }
  | { ok: false; errorCode: NonNullable<ApiResult<never>["errorCode"]>; message: string; code: string | null };

export function createGatewayToolResultCaller(options: { baseUrl: string; deviceToken: string }) {
  let requestCounter = 0;
  return async function callToolResult(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<GatewayToolAnswer> {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        `${options.baseUrl}${TAILNET_MCP_PATH}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${options.deviceToken}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: `ws-${++requestCounter}`, method: "tools/call", params: { name, arguments: args } }),
        },
        timeoutMs,
      );
    } catch {
      return { ok: false, errorCode: "desktop_unavailable", message: "The desktop did not answer. Is Tailscale up on both devices?", code: null };
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (response.status === 401) {
      const refused = unauthorizedResult(body);
      return { ok: false, errorCode: refused.errorCode ?? "unauthenticated", message: refused.message ?? "", code: null };
    }
    if (!response.ok || !body) {
      return { ok: false, errorCode: "desktop_unavailable", message: `The desktop answered ${response.status}.`, code: null };
    }
    if (isRecord(body.error)) {
      const message = typeof body.error.message === "string" ? body.error.message : "The desktop refused the call.";
      return { ok: false, errorCode: "invalid_payload", message, code: /Unknown tool/u.test(message) ? "unknown_tool" : null };
    }
    const result = isRecord(body.result) ? body.result : null;
    const structured = result && isRecord(result.structuredContent) ? result.structuredContent : null;
    if (result?.isError === true || structured?.ok === false) {
      const error = structured && isRecord(structured.error) ? structured.error : null;
      const code = typeof error?.code === "string" ? error.code : "tool_error";
      const message = typeof error?.message === "string" ? error.message : "The desktop refused the call.";
      return { ok: false, errorCode: code === "tailnet_scope_required" ? "unauthorized" : "invalid_payload", message, code };
    }
    if (!structured) {
      return { ok: false, errorCode: "invalid_payload", message: "The desktop returned no structured result.", code: null };
    }
    const content = Array.isArray(result?.content) ? result.content.filter(isRecord) : [];
    return { ok: true, structured, content };
  };
}

/**
 * Calls one gateway tool and answers its structured content, or the failure in
 * the app's words. Both reads need `workspace:read`; a pairing without it is
 * refused as `unauthorized`.
 */
export function createGatewayToolCaller(options: { baseUrl: string; deviceToken: string }) {
  const callToolResult = createGatewayToolResultCaller(options);
  return async function callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<ApiResult<Record<string, unknown>>> {
    const answer = await callToolResult(name, args, timeoutMs);
    return answer.ok
      ? { ok: true, data: answer.structured }
      : { ok: false, errorCode: answer.errorCode, message: answer.message };
  };
}

/**
 * One read over the desktop's Studio, answered or failed in the phone's words.
 * A read that has not answered in `READ_TIMEOUT_MS` fails as unavailable; the
 * connection itself stays, to answer the next.
 */
async function ask<T>(
  options: { baseUrl: string; deviceToken: string },
  read: (client: StudioClient) => Promise<T>,
  studio: DesktopStudioOptions,
): Promise<ApiResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      desktopStudio(options, studio).then(read),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("The desktop did not answer in time.")), READ_TIMEOUT_MS);
      }),
    ]);
    return { ok: true, data: answer };
  } catch (error) {
    const failed = studioFailure(error);
    return { ok: false, errorCode: failed.errorCode, message: failed.message };
  } finally {
    clearTimeout(timer);
  }
}

/** The desktop's projects, from `workspaces.list`'s rows: what the picker and the chat's pill show. */
export function readDesktopWorkspaces(rows: readonly unknown[]): DesktopWorkspace[] {
  const workspaces: DesktopWorkspace[] = [];
  for (const entry of rows) {
    if (!isRecord(entry)) continue;
    const workspaceId = typeof entry.id === "string" ? entry.id : null;
    if (!workspaceId) continue;
    const folderPath = typeof entry.folderPath === "string" && entry.folderPath ? entry.folderPath : null;
    const name = typeof entry.name === "string" && entry.name ? entry.name : workspaceId;
    // The picker lists the PROJECT, not the desktop's window name: those are
    // two vocabularies ("Chat" vs "mobile") and the person picking
    // a project is thinking of the folder. The window name is the fallback
    // when a workspace has no folder at all.
    const repository = isRecord(entry.repository) ? entry.repository : null;
    const canonicalKey =
      typeof repository?.canonicalKey === "string" && repository.canonicalKey.trim()
        ? repository.canonicalKey.trim().toLowerCase()
        : null;
    // A worktree's folder files under the project it was cut from. The
    // desktop's own record wins where it sends one.
    const recorded = isRecord(entry.worktree) && typeof entry.worktree.repoRoot === "string" ? entry.worktree.repoRoot : null;
    const project = workspaceProject({ folderPath, recordedRoot: recorded });
    // "No project" is one group per desktop, and not a project: no hue.
    const projectKey = project.projectless
      ? PROJECTLESS_PROJECT_KEY
      : canonicalKey
        ? `repo:${canonicalKey}`
        : project.projectFolder
          ? `folder:${comparablePath(project.projectFolder)}`
          : null;
    const projectHue = !project.projectless && isProjectHue(entry.projectHue) ? entry.projectHue : null;
    const lastUsedAt = typeof entry.projectLastUsedAt === "string" ? Date.parse(entry.projectLastUsedAt) : NaN;
    const settledAt = readSettledAt(entry.settledAt);
    workspaces.push({
      workspaceId,
      name,
      projectName: project.projectName ?? name,
      folderPath,
      projectFolder: project.projectFolder,
      worktree: project.worktree,
      ...(project.projectless ? { projectless: true } : {}),
      projectKey,
      projectHue,
      ...(typeof entry.projectFrecency === "number" && Number.isFinite(entry.projectFrecency) && entry.projectFrecency >= 0
        ? { projectFrecency: entry.projectFrecency, projectLastUsedAt: Number.isFinite(lastUsedAt) ? lastUsedAt : null }
        : {}),
      ...(settledAt !== null ? { settledAt } : {}),
    });
  }
  return oneHuePerProject(workspaces);
}

export function createTailnetWorkspacesApi(
  options: { baseUrl: string; deviceToken: string },
  studio: DesktopStudioOptions = {},
): WorkspacesApi {
  return {
    listCliRuntimes: () =>
      ask(options, async (client) => readCliRuntimes(await client.rpc["cliRuntimes.list"]({})), studio),
    listWorkspaces: () =>
      ask(options, async (client) => readDesktopWorkspaces((await client.rpc["workspaces.list"]({})).workspaces), studio),
    readCheckout: (workspace) =>
      ask(
        options,
        async (client) =>
          readWorkspaceCheckout(
            await client.rpc["workspaces.checkout"]({ workspaceId: workspace.workspaceId }),
            workspace.folderPath,
          ),
        studio,
      ),
  };
}

/** The project key every "No project" chat of a desktop shares. */
export const PROJECTLESS_PROJECT_KEY = "noproject:";

/**
 * Every workspace of one project in one colour.
 *
 * The desktop hashes each workspace's hue from its repository, else from its
 * own folder. For a project with no remote, that makes each pooled worktree
 * (`demo-app-04`, `demo-app-07`) a colour of its own while the phone files
 * them all under `demo-app`: one header, rows in three hues. The project's own
 * checkout is the colour the desktop's sidebar paints the project, so its hue
 * wins where it is listed; else the first worktree's, in list order, so a
 * re-read does not move it. The hue is never derived here (theme/projectHue.ts).
 */
export function oneHuePerProject<W extends Pick<DesktopWorkspace, "projectKey" | "projectHue" | "worktree">>(
  workspaces: readonly W[],
): W[] {
  const hues = new Map<string, { hue: number; checkout: boolean }>();
  for (const workspace of workspaces) {
    if (!workspace.projectKey || workspace.projectHue === null) continue;
    const checkout = !workspace.worktree;
    const held = hues.get(workspace.projectKey);
    if (held && (held.checkout || !checkout)) continue;
    hues.set(workspace.projectKey, { hue: workspace.projectHue, checkout });
  }
  return workspaces.map((workspace) => {
    const hue = workspace.projectKey ? hues.get(workspace.projectKey)?.hue : undefined;
    return hue === undefined || hue === workspace.projectHue ? workspace : { ...workspace, projectHue: hue };
  });
}

/**
 * A workspace's `settledAt`: an instant in whole, non-negative milliseconds,
 * or null for anything else, which reads as not settled. A desktop that sent
 * one in a shape this build does not know still leaves the chat off its own
 * list, so reading it as unsettled here hides nothing it should show.
 */
export function readSettledAt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

