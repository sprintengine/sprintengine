import { openDiffTab } from '../components/workspace/pane/popout/panePopOutHost'
import type { EditorRange } from '../../../shared/editor-reveal'
import type { BranchStepSelection } from '../../../shared/electron-api'

export type OpenGitDiffInput = {
  /** The workspace the row was activated in: the pane the diff docks into. */
  workspaceId: string
  /**
   * The repository the row belongs to, as the CALLER knows it — the Git panel's
   * active scope, the File Explorer's status root. Never re-derived downstream:
   * a workspace mounted on one worktree can be showing another scope's rows,
   * and re-deriving from the workspace opened the diff on the wrong repository.
   */
  repoRoot: string
  focusPath: string
  /** Which side to open on: `staged` is HEAD↔index, `unstaged` index↔worktree. */
  scope: 'staged' | 'unstaged'
  /**
   * Show only one changelist's files (`changelistOwnerId` for an owned list).
   * Absent means "All changes", which is what every caller meant before agent
   * changelists existed and still means today — the filter is additive, never
   * a default the viewer invents for itself.
   */
  changelistId?: string
  /**
   * An agent's reveal (editor.open_diff): the files to narrow to, the branch
   * step and the lines to land on. `takeFocus: false` never takes the keyboard
   * or raises the window; `background` only writes the tab, opening no window.
   */
  reveal?: {
    key: string
    paths?: string[]
    step?: BranchStepSelection
    range?: EditorRange
    side?: 'modified' | 'original'
  }
  takeFocus?: boolean
  background?: boolean
}

// Single routing point for "show me this file's diff". Every diff shows in the
// Diff tab's own window (`openDiffTab`): the Git panel's rows, the File
// Explorer's "View Git diff", a turn's changes, an agent's reveal. The window
// is the pane's Diff tab popped out, so it steps through a branch, plays a
// tour and reads a paired machine's changes the way the pane did; a shell with
// no second window keeps it in the pane.
export function openGitDiff(input: OpenGitDiffInput): void {
  openDiffTab(input.workspaceId, {
    diff: {
      repoRoot: input.repoRoot,
      focusPath: input.focusPath,
      focusKind: input.scope,
      ...(input.changelistId ? { changelistId: input.changelistId } : {}),
      ...(input.reveal ? { reveal: input.reveal } : {}),
    },
    ...(input.background ? { activate: false } : {}),
    ...(input.takeFocus === false ? { focus: false } : {}),
  })
}
