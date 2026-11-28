import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import { isRecord } from '../shared/records'
import type { StudioDatabase } from '../server/db/database'
import type { GitCommandResult } from './git'
import { runGitCommand } from './git-run'

/**
 * The branches Studio made for worktrees, per repository: the only ones,
 * besides those under `agent/`, that the agent worktree cleanup may delete.
 *
 * A branch's name cannot say who made it once the person chooses the prefix
 * (Settings ▸ Worktrees): `feat/fix-login` may be Studio's or their own, and an
 * empty prefix names Studio's branches like anyone's. So every branch Studio
 * names for a worktree is written down here as it is made (a new chat's or an
 * agent's worktree, a pool lease, a pool slot's held or rescued work), and the
 * cleanup deletes a merged branch only when it finds it here or under `agent/`,
 * the namespace Studio's branches had before the prefix could be chosen.
 *
 * Keyed by the repository's common git directory with symlinks resolved, which
 * every worktree of a repository shares, however its checkout is spelled. Kept
 * in the server's database (`worktree_branches`, a row per branch, numbered in
 * the order they were recorded); each change is one transaction. Each
 * repository keeps its newest `MAX_BRANCHES_PER_REPO` names, and the table its
 * `MAX_REPOS` most recently recorded-in repositories: a name that falls off is
 * a branch the cleanup leaves for the person, never one it deletes by mistake.
 *
 * Only the Studio server that holds the data folder keeps it: it is the one
 * process that makes and cleans agent worktrees there. A process with no
 * ledger installed records nothing and knows nothing, which deletes nothing
 * but `agent/` branches.
 */

/** The file builds before the database kept the ledger in, under the data folder; read once, by the import. */
export const WORKTREE_BRANCHES_FILE = 'worktree-branches.json'
const VERSION = 1
const MAX_BRANCHES_PER_REPO = 2_000
const MAX_REPOS = 200

type RunGit = (cwd: string, args: string[]) => Promise<GitCommandResult>

export type WorktreeBranchLedgerDeps = {
  database: StudioDatabase
  runGit?: RunGit
  log?: (line: string) => void
}

export type WorktreeBranchLedger = {
  /** Write down that Studio made `branch` in the repository at `repoPath` (any path inside it). */
  record(repoPath: string, branch: string): Promise<void>
  /** The branches Studio made in the repository at `repoPath`, oldest first; empty when none are known. */
  branches(repoPath: string): Promise<ReadonlySet<string>>
  /** Strike names off: Studio deleted those branches, or they are gone. */
  forget(repoPath: string, branches: Iterable<string>): Promise<void>
}

/**
 * The ledger file builds before the database wrote, as the import brings it
 * in: each repository's branches, oldest first, the repositories in the order
 * they were last recorded in. Null when this build cannot read it.
 */
export function readWorktreeBranchesFile(text: string): Array<{ repo: string; branches: string[] }> | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw) || raw.version !== VERSION || !isRecord(raw.repos)) return null
  const repos: Array<{ repo: string; branches: string[]; updatedAt: number }> = []
  for (const [repo, entry] of Object.entries(raw.repos)) {
    if (!repo || !isRecord(entry) || !Array.isArray(entry.branches)) continue
    const branches = entry.branches.filter((branch): branch is string => typeof branch === 'string' && branch !== '')
    if (branches.length === 0) continue
    const updatedAt = typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0
    repos.push({ repo, branches: [...new Set(branches)].slice(-MAX_BRANCHES_PER_REPO), updatedAt })
  }
  return repos
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(-MAX_REPOS)
    .map(({ repo, branches }) => ({ repo, branches }))
}

/** The statements that keep one repository's newest names, and the newest repositories. */
const TRIM_STATEMENTS = (repo: string) => [
  {
    sql: `DELETE FROM worktree_branches WHERE repo = ? AND seq NOT IN
            (SELECT seq FROM worktree_branches WHERE repo = ? ORDER BY seq DESC LIMIT ${MAX_BRANCHES_PER_REPO})`,
    params: [repo, repo],
  },
  {
    sql: `DELETE FROM worktree_branches WHERE repo NOT IN
            (SELECT repo FROM worktree_branches GROUP BY repo ORDER BY MAX(seq) DESC LIMIT ${MAX_REPOS})`,
  },
]

export function createWorktreeBranchLedger(deps: WorktreeBranchLedgerDeps): WorktreeBranchLedger {
  const runGit: RunGit = deps.runGit ?? ((cwd, args) => runGitCommand(cwd, args))
  const log = deps.log ?? ((line: string) => console.warn(`[worktree-branches] ${line}`))
  // A repository's identity, per path asked about: a git process once, not per call.
  const identities = new Map<string, Promise<string | null>>()
  let chain: Promise<unknown> = Promise.resolve()

  function identity(repoPath: string): Promise<string | null> {
    let known = identities.get(repoPath)
    if (!known) {
      known = runGit(repoPath, ['rev-parse', '--git-common-dir']).then(
        async (result) => {
          const dir = result.ok ? result.stdout.trim() : ''
          if (!dir) return null
          const absolute = isAbsolute(dir) ? dir : resolve(repoPath, dir)
          return realpath(absolute).catch(() => absolute)
        },
        () => null,
      )
      // A failed lookup is asked again next time: the folder may be a repository by then.
      void known.then((value) => {
        if (value === null) identities.delete(repoPath)
      })
      identities.set(repoPath, known)
    }
    return known
  }

  /** Run a change for the repository at `repoPath`, after every change this process asked for before it. */
  function update(
    repoPath: string,
    statements: (repo: string) => Array<{ sql: string; params?: string[] }>,
  ): Promise<void> {
    const run = chain.then(async () => {
      const repo = await identity(repoPath)
      if (!repo) return
      await deps.database.batch(statements(repo))
    })
    // One failed write is logged and does not stop the next: a branch left
    // unrecorded is one the cleanup leaves alone.
    chain = run.catch((error: unknown) => log(`could not update the record: ${String(error)}`))
    return chain.then(() => undefined)
  }

  return {
    record(repoPath, branch) {
      return update(repoPath, (repo) => [
        // Recorded again, it is the newest.
        { sql: 'DELETE FROM worktree_branches WHERE repo = ? AND branch = ?', params: [repo, branch] },
        { sql: 'INSERT INTO worktree_branches (repo, branch) VALUES (?, ?)', params: [repo, branch] },
        ...TRIM_STATEMENTS(repo),
      ])
    },

    async branches(repoPath) {
      // What this process recorded a moment ago is part of the answer.
      await chain
      const repo = await identity(repoPath).catch(() => null)
      if (!repo) return new Set()
      try {
        const rows = await deps.database.all<{ branch: string }>(
          'SELECT branch FROM worktree_branches WHERE repo = ? ORDER BY seq',
          [repo],
        )
        return new Set(rows.map((row) => row.branch))
      } catch (error) {
        log(`could not read the record: ${String(error)}`)
        return new Set()
      }
    },

    forget(repoPath, branches) {
      const gone = [...new Set(branches)]
      if (gone.length === 0) return Promise.resolve()
      return update(repoPath, (repo) =>
        gone.map((branch) => ({
          sql: 'DELETE FROM worktree_branches WHERE repo = ? AND branch = ?',
          params: [repo, branch],
        })),
      )
    },
  }
}

const NOTHING_KEPT: WorktreeBranchLedger = {
  record: async () => undefined,
  branches: async () => new Set(),
  forget: async () => undefined,
}

let installed: WorktreeBranchLedger | null = null

/** Keep `ledger` as this process's, or none (its server stopped). The Studio core installs its own. */
export function installWorktreeBranchLedger(ledger: WorktreeBranchLedger | null): void {
  installed = ledger
}

/** The ledger of the Studio server in this process; one that keeps nothing when no server is. */
export function worktreeBranchLedger(): WorktreeBranchLedger {
  return installed ?? NOTHING_KEPT
}
