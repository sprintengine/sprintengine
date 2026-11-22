import { stat } from 'fs/promises'
import { isAbsolute, resolve } from 'path'

// A project's knowledge folder: the one setting that tells an agent where the
// project keeps its notes (Settings ▸ Knowledge, `projectKnowledgeRoots`). A
// launch resolves it here and names it in the host-context document's
// knowledge section; Settings resolves it to say whether the path is there.
import type { KnowledgeRootStatus } from '../shared/ipc/knowledge'

export type { KnowledgeRootStatus }

function normalizeKnowledgeRelativeRoot(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/u, '')
  if (!normalized || normalized === '.' || isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) return null
  return normalized
}

export async function resolveKnowledgeRoot(
  workspaceRoot: string | null | undefined,
  relativeRootInput: string | null | undefined,
): Promise<KnowledgeRootStatus> {
  const relativeRoot = normalizeKnowledgeRelativeRoot(relativeRootInput)
  if (!workspaceRoot?.trim()) {
    return {
      ok: false,
      status: 'missing-workspace',
      relativeRoot,
      message: 'Open a workspace folder before setting a knowledge folder.',
    }
  }
  if (!relativeRoot) {
    return {
      ok: false,
      status: 'invalid-relative-path',
      relativeRoot: null,
      message: 'Knowledge path must be a non-empty relative path.',
    }
  }

  const rootPath = resolve(workspaceRoot, relativeRoot)
  try {
    const stats = await stat(rootPath)
    if (!stats.isDirectory()) {
      return {
        ok: false,
        status: 'missing-knowledge-root',
        relativeRoot,
        message: 'Configured knowledge path is not a folder.',
      }
    }
  } catch (error) {
    return {
      ok: false,
      status: 'missing-knowledge-root',
      relativeRoot,
      message: error instanceof Error ? error.message : 'Configured knowledge folder is missing.',
    }
  }

  return { ok: true, rootPath, relativeRoot }
}
