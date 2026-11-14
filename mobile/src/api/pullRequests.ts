import type {
  StudioPullRequestCheck,
  StudioPullRequestDetail,
  StudioPullRequestDiffPage,
  StudioPullRequestRemark,
} from "../../../packages/studio-protocol/src/public";
import { readPullRequestDetail as askDetail, readPullRequestDiff as askDiff } from "./desktopReads";
import type { DesktopStudioOptions, DesktopTarget } from "./desktopStudio";
import type { ApiResult } from "./types";

// A pull request as the phone's viewer shows it, read from the desktop that
// lists it: `pullRequests.detail` for its detail and `pullRequests.diff` for a
// page of one file's diff, on the desktop's Studio protocol. The desktop asks
// GitHub through its own `gh` and cuts every list down before it sends it, so
// an answer is a screen of a pull request, not the whole of it.
//
// The shapes are the protocol's. What another machine sends is still read
// member by member: an answer in a shape this build does not know is read as
// no answer, never half of one. Pure and exported, so the regression suite
// reads the same rules the screens run.

export type PullRequestState = StudioPullRequestDetail["state"];
export type PullRequestCheckStatus = StudioPullRequestCheck["status"];
export type PullRequestCheck = StudioPullRequestCheck;
export type PullRequestRemark = StudioPullRequestRemark;
export type PullRequestChangedFile = NonNullable<StudioPullRequestDetail["files"]>["items"][number];
export type PullRequestDetail = StudioPullRequestDetail;
export type PullRequestDiffPage = Omit<StudioPullRequestDiffPage, "url">;

export interface PullRequestApi {
  read(url: string): Promise<ApiResult<PullRequestDetail>>;
  diff(url: string, path: string, offset?: number): Promise<ApiResult<PullRequestDiffPage>>;
}

export function createPullRequestApi(target: DesktopTarget, options: DesktopStudioOptions = {}): PullRequestApi {
  return {
    async read(url) {
      const result = await askDetail(target, url, options);
      if (!result.ok) return { ok: false, errorCode: result.errorCode, message: result.message };
      const detail = readPullRequestDetail(result.data);
      return detail
        ? { ok: true, data: detail }
        : {
            ok: false,
            errorCode: "invalid_payload",
            message: "The desktop's answer about this pull request could not be read.",
          };
    },
    async diff(url, path, offset = 0) {
      const result = await askDiff(target, offset > 0 ? { url, path, offset } : { url, path }, options);
      if (!result.ok) return { ok: false, errorCode: result.errorCode, message: result.message };
      const page = readPullRequestDiffPage(result.data, path);
      return page
        ? { ok: true, data: page }
        : {
            ok: false,
            errorCode: "invalid_payload",
            message: "The desktop's answer about this file could not be read.",
          };
    },
  };
}

/**
 * Whether a refusal says the desktop does not serve the reads at all: one
 * from before them, which answers the method as unknown.
 */
export function pullRequestReadsUnsupported(result: Pick<ApiResult<unknown>, "ok" | "errorCode" | "message">): boolean {
  return !result.ok && result.errorCode === "command_not_supported";
}

/** The detail, or null when the answer is not in its shape. */
export function readPullRequestDetail(value: unknown): PullRequestDetail | null {
  if (!isRecord(value) || typeof value.url !== "string") return null;
  if (value.state !== "open" && value.state !== "merged" && value.state !== "closed") return null;
  const checks = isRecord(value.checks) ? value.checks : null;
  const reviews = isRecord(value.reviews) ? value.reviews : null;
  const remarks = isRecord(value.remarks) ? value.remarks : null;
  if (!checks || !reviews || !remarks) return null;
  const files = isRecord(value.files) ? value.files : null;
  return {
    url: value.url,
    number: positive(value.number),
    title: text(value.title),
    state: value.state,
    isDraft: value.isDraft === true,
    author: text(value.author),
    baseRefName: text(value.baseRefName),
    headRefName: text(value.headRefName),
    openedAt: count(value.openedAt) || null,
    endedAt: count(value.endedAt) || null,
    mergeable: value.mergeable === "mergeable" || value.mergeable === "conflicting" ? value.mergeable : "unknown",
    checks: {
      passed: count(checks.passed),
      failed: count(checks.failed),
      pending: count(checks.pending),
      items: list(checks.items, readCheck),
    },
    reviewDecision:
      value.reviewDecision === "approved" ||
      value.reviewDecision === "changes-requested" ||
      value.reviewDecision === "review-required"
        ? value.reviewDecision
        : null,
    reviews: {
      approved: count(reviews.approved),
      changesRequested: count(reviews.changesRequested),
      commented: count(reviews.commented),
    },
    remarks: { total: count(remarks.total), latest: list(remarks.latest, readRemark) },
    files: files
      ? {
          total: count(files.total),
          additions: count(files.additions),
          deletions: count(files.deletions),
          items: list(files.items, readFile),
        }
      : null,
  };
}

/** A diff page for `path`, or null when the answer is not one, or is another file's. */
export function readPullRequestDiffPage(value: unknown, path: string): PullRequestDiffPage | null {
  if (!isRecord(value) || value.path !== path || typeof value.patch !== "string") return null;
  if (!Number.isSafeInteger(value.offset) || (value.offset as number) < 0) return null;
  const next = value.nextOffset;
  if (next !== null && !(Number.isSafeInteger(next) && (next as number) > (value.offset as number))) return null;
  return {
    path,
    patch: value.patch,
    offset: value.offset as number,
    nextOffset: next as number | null,
    totalLines: count(value.totalLines),
  };
}

/** The pages of one file read so far, as one diff: each page is whole lines, the next starting where it ended. */
export function joinDiffPages(pages: readonly PullRequestDiffPage[]): string {
  return pages.map((page) => page.patch).join("\n");
}

function readCheck(value: unknown): PullRequestCheck | null {
  if (!isRecord(value) || !text(value.name)) return null;
  if (value.status !== "pending" && value.status !== "passed" && value.status !== "failed") return null;
  return {
    name: value.name as string,
    workflow: typeof value.workflow === "string" ? value.workflow : "",
    status: value.status,
    required: value.required === true,
  };
}

function readRemark(value: unknown): PullRequestRemark | null {
  if (!isRecord(value) || (value.kind !== "comment" && value.kind !== "review")) return null;
  const verdict =
    value.verdict === "approved" || value.verdict === "changes-requested" || value.verdict === "commented"
      ? value.verdict
      : undefined;
  return {
    kind: value.kind,
    author: text(value.author) ?? "someone",
    ...(verdict ? { verdict } : {}),
    excerpt: typeof value.excerpt === "string" ? value.excerpt : "",
    at: count(value.at),
  };
}

function readFile(value: unknown): PullRequestChangedFile | null {
  if (!isRecord(value) || !text(value.path)) return null;
  return {
    path: value.path as string,
    additions: count(value.additions),
    deletions: count(value.deletions),
    change: text(value.change),
  };
}

function list<T>(value: unknown, read: (entry: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const entry of value) {
    const item = read(entry);
    if (item) out.push(item);
  }
  return out;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
