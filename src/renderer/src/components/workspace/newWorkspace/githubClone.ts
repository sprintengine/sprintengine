/**
 * Pure helpers for the Import from Git step: resolving what was typed or
 * picked into a clone source, filtering the GitHub repository list, saying a
 * clone's progress in words, and where a browsed-to folder puts the clone.
 * Kept beside folderCreation.ts and unit-tested the same way.
 */
import type { CloneProgress } from '../../../../../shared/electron-api'
import { providerLabel, validateCloneUrl, type GitHostProvider } from '../../../../../shared/git-clone-url'
import { basename, parentPath } from '../../../utils/paths'

export type CloneSource = {
  url: string
  repoName: string
  provider: GitHostProvider
  /** The provider as a word: `GitLab`, or the host itself for a plain Git server. */
  providerName: string
  /** Where it lives, as a person reads it: `gitlab.acme.dev/platform/api`. */
  location: string
  /** The branch the pasted page or command named, or null. */
  branch: string | null
  insecure: boolean
}

export type CloneSourceResolution = { source: CloneSource; error: null } | { source: null; error: string | null }

/**
 * The clone source a draft names. A picked GitHub repository fills the draft
 * with its clone URL, so there is one source of truth either way. A blank
 * draft is "nothing chosen yet" (error: null); a non-blank draft that does not
 * parse carries the validation error for inline display.
 */
export function resolveCloneSource(urlDraft: string): CloneSourceResolution {
  if (!urlDraft.trim()) return { source: null, error: null }
  const validated = validateCloneUrl(urlDraft)
  if (!validated.ok) return { source: null, error: validated.error }
  return {
    source: {
      url: validated.url,
      repoName: validated.repoName,
      provider: validated.provider,
      providerName: providerLabel(validated.provider),
      location: `${validated.host}/${validated.path}`,
      branch: validated.branch,
      insecure: validated.insecure,
    },
    error: null,
  }
}

const STAGE_WORDS: Record<CloneProgress['stage'], string> = {
  connecting: 'Connecting',
  counting: 'Counting objects',
  receiving: 'Receiving objects',
  resolving: 'Resolving deltas',
  checkout: 'Checking out files',
}

/** A clone's progress as one line: `Receiving objects · 45% · 12.30 MiB | 5.00 MiB/s`. */
export function describeCloneProgress(progress: Pick<CloneProgress, 'stage' | 'percent' | 'detail'> | null): string {
  if (!progress) return 'Starting…'
  return [STAGE_WORDS[progress.stage], progress.percent === null ? null : `${progress.percent}%`, progress.detail]
    .filter(Boolean)
    .join(' · ')
}

/**
 * Where a folder picked with Change… puts the clone. Picking a folder that
 * already carries the clone's name means "clone into this one", not "clone
 * into a folder of that name inside it" — the `repo/repo` nobody wants.
 */
export function cloneParentFor(picked: string, folderName: string): string {
  return basename(picked) === folderName ? parentPath(picked) : picked
}
