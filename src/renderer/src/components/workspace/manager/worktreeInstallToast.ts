// The dependency install a leased pool worktree runs before its agent starts
// (main's worktree-pool/dependency-install.ts), told as one toast re-shown in
// place: "Installing dependencies" while it runs, then how it ended. No
// buttons — Settings ▸ Worktrees shows the install on its worktree's row with
// Cancel, so the toast is never the only way to it. One that did not succeed
// is also a bell row carrying what the install printed: the toast leaves, the
// reason why the agent's tests will not run should not.

import type { WorktreeDependencyInstallView } from '../../../../../shared/electron-api'
import { showToast } from '../../../store/toastStore'
import { publishDiagnosticSync } from '../../../utils/diagnostics'
import { copy } from '../../../../../shared/copy'

const REASON: Record<WorktreeDependencyInstallView['reason'], string> = {
  first: 'its first install',
  changed: 'the lockfile changed',
  missing: 'its dependencies were gone',
}

function worktreeName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).pop() ?? path
}

function seconds(view: WorktreeDependencyInstallView): string {
  const elapsed = Math.max(0, Math.round(((view.endedAt ?? view.startedAt) - view.startedAt) / 1000))
  return elapsed < 60 ? `${elapsed} s` : `${Math.floor(elapsed / 60)} min ${elapsed % 60} s`
}

/** The ids already announced as running, so progress does not re-show a toast the person dismissed. */
const announced = new Set<string>()

/**
 * Show where an install is. `report` publishes the bell row for one that did
 * not succeed; one window reports it, every window shows the toast.
 */
export function showWorktreeInstallToast(view: WorktreeDependencyInstallView, options: { report: boolean }): void {
  // One its caller shows (New chat's, in its chat's working line) is told
  // here only if it did not succeed: that outlives the chat's setup.
  if (view.quiet && (view.state === 'running' || view.state === 'succeeded' || view.state === 'cancelled')) return
  const id = `worktree-install:${view.id}`
  const where = `${view.command} in ${worktreeName(view.path)}`
  if (view.state === 'running') {
    if (announced.has(view.id)) return
    announced.add(view.id)
    showToast({
      id,
      tone: 'accent',
      title: copy.workspace.manager.worktreeInstallToast.installingDependencies,
      description: copy.workspace.manager.worktreeInstallToast.theAgentStartsAfter(where, REASON[view.reason]),
      autoDismissMs: false,
    })
    return
  }
  announced.delete(view.id)
  if (view.state === 'succeeded') {
    showToast({
      id,
      tone: 'good',
      title: copy.workspace.manager.worktreeInstallToast.dependenciesInstalled,
      description: `${where}, ${seconds(view)}.`,
    })
    return
  }
  if (view.state === 'cancelled') {
    showToast({
      id,
      tone: 'neutral',
      title: copy.workspace.manager.worktreeInstallToast.dependencyInstallCancelled,
      description: copy.workspace.manager.worktreeInstallToast.theAgentStartedWithoutIt(worktreeName(view.path)),
    })
    return
  }
  const what =
    view.state === 'timed-out'
      ? `${where} was stopped after ${seconds(view)}.`
      : `${where} failed${view.exitCode !== null ? ` (exit code ${view.exitCode})` : ''}.`
  showToast({
    id,
    tone: 'warn',
    title: copy.workspace.manager.worktreeInstallToast.dependenciesDidNotInstall,
    description: copy.workspace.manager.worktreeInstallToast.theAgentStartedAnywayThe(what),
  })
  if (!options.report) return
  publishDiagnosticSync({
    level: 'warning',
    source: 'workspace',
    title: copy.workspace.manager.worktreeInstallToast.dependenciesDidNotInstall,
    message: copy.workspace.manager.worktreeInstallToast.theAgentOnStartedWithout(what, view.branch),
    ...(view.output ? { details: view.output } : {}),
    navigationTarget: { kind: 'settings', ref: 'worktrees' },
  })
}
