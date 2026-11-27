import {
  isFileView,
  type RowTool,
} from "../../../../packages/conversation-timeline/src/public";
import { clipLines, EXPANDED_LINES, type ClippedText } from "./toolOutput";

// The steps an agent took to show the person something, drawn as cards of
// their own rather than as steps of its work, as the desktop draws them
// (`stepShownToUser` in conversation-timeline's turnFolds.ts): the files it
// showed with Studio's `file.view`. A picture it generated is the other,
// drawn by `conversationImageLogic.ts`.
//
// A card is drawn only where the phone can draw it; anywhere else the call
// stays the ordinary step it was, folded with the turn's work. So the rows
// hold a step out of the fold (`shownToUser`) only together with its card.

/** What the phone can draw as a card in this chat. */
export type ShownCards = {
  /** The desktop serves the files a chat showed to this pairing (`fileViews.read`). */
  fileViews: boolean;
};

/** Which card a step is drawn as here, or null for its ordinary step. */
export type ShownCard = "file-view";

/**
 * The card a step is drawn as. A call that failed is its step, as on the
 * desktop, and a file view needs the desktop to serve the file.
 */
export function shownCard(tool: Pick<RowTool, "name" | "serverName" | "status">, cards: ShownCards): ShownCard | null {
  if (tool.status === "error") return null;
  if (cards.fileViews && isFileView(tool)) return "file-view";
  return null;
}

/**
 * Whether a step's result is for the person to look at: a picture it
 * generated, as the shared layout's default holds, or one the phone draws as
 * a card. Such a step is drawn under its turn's fold line and not counted.
 */
export function phoneShownToUser(tool: RowTool, cards: ShownCards): boolean {
  if (tool.status === "error") return false;
  return tool.name === "GenerateImage" || shownCard(tool, cards) !== null;
}

// ── Files shown in the chat ────────────────────────────────────────────────

/** Lines the agent pointed at in a file, with what it said of them. */
export type FileViewHighlight = { from: number; to: number; note?: string };

/** One file a `file.view` call showed: its path on the chat's machine, its name, and the lines to look at. */
export type FileViewFile = { path: string; name: string; highlights: FileViewHighlight[] };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsed(output: string | undefined): Record<string, unknown> | null {
  if (!output) return null;
  try {
    const value: unknown = JSON.parse(output);
    return record(value) ? value : null;
  } catch {
    return null;
  }
}

const nameOf = (path: string) => path.split(/[\\/]/u).filter(Boolean).pop() ?? path;

function highlightsOf(value: unknown): FileViewHighlight[] {
  if (!Array.isArray(value)) return [];
  const ranges: FileViewHighlight[] = [];
  for (const item of value) {
    if (!record(item) || typeof item.from !== "number" || !Number.isFinite(item.from)) continue;
    const from = Math.max(1, Math.trunc(item.from));
    const to = typeof item.to === "number" && Number.isFinite(item.to) ? Math.max(from, Math.trunc(item.to)) : from;
    const note = typeof item.note === "string" && item.note.trim() ? item.note.trim() : undefined;
    ranges.push({ from, to, ...(note ? { note } : {}) });
  }
  return ranges.sort((a, b) => a.from - b.from);
}

/**
 * The files a `file.view` call showed, as its answer names them (the desktop's
 * `fileViewFiles`): each by the real path the chat's Studio resolved, which is
 * the path `fileViews.read` answers for. Empty when the answer cannot be read
 * (a call still running, failed, or cut short on the wire): the call then
 * stays its step.
 */
export function fileViewFiles(tool: Pick<RowTool, "output" | "status">): FileViewFile[] {
  if (tool.status === "running" || tool.status === "error") return [];
  const answer = parsed(tool.output);
  if (!answer || !Array.isArray(answer.files)) return [];
  const files: FileViewFile[] = [];
  for (const item of answer.files) {
    if (!record(item) || typeof item.path !== "string" || !item.path) continue;
    if (files.some((file) => file.path === item.path)) continue;
    files.push({
      path: item.path,
      name: typeof item.name === "string" && item.name ? item.name : nameOf(item.path),
      highlights: highlightsOf(item.highlights),
    });
  }
  return files;
}

/**
 * Each file's label among the others: its name, or, where two share it, as
 * many of its last path parts as tell it apart (`a/CLAUDE.md`, `b/CLAUDE.md`).
 */
export function fileViewLabels(files: readonly FileViewFile[]): string[] {
  const parts = files.map((file) => file.path.split(/[\\/]/u).filter(Boolean));
  const tail = (index: number, depth: number) => parts[index].slice(-depth).join("/");
  return files.map((file, index) => {
    const twins = files.map((_, other) => other).filter((other) => other !== index && files[other].name === file.name);
    if (twins.length === 0) return file.name;
    for (let depth = 2; depth <= parts[index].length; depth += 1) {
      const label = tail(index, depth);
      if (twins.every((other) => tail(other, depth) !== label)) return label;
    }
    return file.path;
  });
}

/** How many lines a closed card shows: about what the desktop's editor shows before it scrolls. */
export const FILE_VIEW_LINES = 18;
/** Lines kept above the first line the agent pointed at, so it reads in its place. */
const LEAD_LINES = 2;

/** The part of a file a card draws, and where in the file it starts (1-based). */
export type FileViewExcerpt = ClippedText & { firstLine: number };

/**
 * What a card draws of a file. Closed, it opens where the agent pointed (a
 * line or two above its first range), as the desktop's editor opens scrolled
 * to it, or at the top; open, the file from its top, up to the lines any long
 * output shows. A trailing line break ends the last line.
 */
export function fileViewExcerpt(text: string, highlights: readonly FileViewHighlight[], all: boolean): FileViewExcerpt {
  if (all) return { ...clipLines(text, "head", EXPANDED_LINES), firstLine: 1 };
  const total = clipLines(text, "head", 0).total;
  const pointed = highlights[0]?.from;
  const start = pointed === undefined ? 1 : Math.max(1, Math.min(pointed - LEAD_LINES, total - FILE_VIEW_LINES + 1));
  if (start === 1) return { ...clipLines(text, "head", FILE_VIEW_LINES), firstLine: 1 };
  let offset = 0;
  for (let line = 1; line < start; line++) offset = text.indexOf("\n", offset) + 1;
  const clip = clipLines(text.slice(offset), "head", FILE_VIEW_LINES);
  return { ...clip, total, hidden: total - (clip.total - clip.hidden), offset, firstLine: start };
}

/** The language a file's source is coloured as, from its extension. */
export function fileViewLanguage(name: string): string | undefined {
  const extension = /\.([a-z0-9]+)$/iu.exec(name)?.[1]?.toLowerCase();
  if (!extension) return undefined;
  const known: Record<string, string> = {
    js: "js",
    mjs: "js",
    cjs: "js",
    jsx: "jsx",
    ts: "ts",
    mts: "ts",
    cts: "ts",
    tsx: "tsx",
    json: "json",
    py: "py",
    sh: "sh",
    bash: "bash",
    zsh: "sh",
    java: "java",
    diff: "diff",
    patch: "patch",
  };
  return known[extension];
}
