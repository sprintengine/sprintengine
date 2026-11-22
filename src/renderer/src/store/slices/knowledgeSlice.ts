import { normalizeProjectRootKey } from '../../utils/projectKnowledge'
import { launchSettingsClient } from '../launchSettingsClient'
import type { AppSettings } from '../../../../shared/workspace'

// Each project's knowledge folder (Settings ▸ Knowledge): the folder an agent
// launched in the project is told about, as a path relative to the project.

export function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\')
}

export function normalizeKnowledgeRelativeRoot(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/u, '')
  if (!normalized || normalized === '.' || isAbsolutePath(normalized)) return null
  return normalized
}

export function normalizeProjectKnowledgeRoots(roots: unknown): Record<string, string | null> {
  const normalized: Record<string, string | null> = {}
  if (!roots || typeof roots !== 'object') return normalized
  for (const [projectRoot, relativeRoot] of Object.entries(roots as Record<string, unknown>)) {
    const key = normalizeProjectRootKey(projectRoot)
    const root = normalizeKnowledgeRelativeRoot(relativeRoot)
    if (key && root) normalized[key] = root
  }
  return normalized
}

export type KnowledgeSlice = {
  setProjectKnowledgeRoot: (projectRoot: string, relativeRoot: string | null) => void
}

type KnowledgeSliceCarrier = { appSettings: AppSettings }
type KnowledgeSliceSet = (mutator: (state: KnowledgeSliceCarrier) => void) => void

export function createKnowledgeSlice(set: KnowledgeSliceSet): KnowledgeSlice {
  return {
    // Knowledge roots are one of main's launch settings: the change applies
    // here at once and goes to main as a one-key patch (null removes it);
    // main's answer replaces this window's copy (launchSettingsClient).
    setProjectKnowledgeRoot: (projectRoot, relativeRoot) => {
      const key = normalizeProjectRootKey(projectRoot)
      if (!key) return
      const normalizedRoot = normalizeKnowledgeRelativeRoot(relativeRoot)
      set((state) => {
        state.appSettings.projectKnowledgeRoots = normalizeProjectKnowledgeRoots(
          state.appSettings.projectKnowledgeRoots,
        )
        if (normalizedRoot) {
          state.appSettings.projectKnowledgeRoots[key] = normalizedRoot
        } else {
          delete state.appSettings.projectKnowledgeRoots[key]
        }
      })
      launchSettingsClient.update({ projectKnowledgeRoots: { [key]: normalizedRoot } })
    },
  }
}
