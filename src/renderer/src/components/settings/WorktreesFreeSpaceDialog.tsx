import React, { useId, useMemo, useState } from 'react'

import { DescribedCheckRow, DescribedCheckRowList } from '../ui'
import { DangerButton, GhostButton } from '../ui/Buttons'
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal'
import {
  bytesOf,
  formatBytes,
  planFreeSpace,
  type WorktreeProjectView,
  type WorktreeRow,
} from './worktreesSettingsModel'
import { copy } from '../../../../shared/copy'

function names(rows: readonly WorktreeRow[]): string {
  const shown = rows.slice(0, 4).map((row) => `${row.name} (${formatBytes(row.bytes)})`)
  return rows.length > 4 ? `${shown.join(', ')} and ${rows.length - 4} more` : shown.join(', ')
}

/**
 * Free up space: the removals Settings ▸ Worktrees can make without asking
 * about each worktree, because none of them loses anything. Nothing in use or
 * holding uncommitted work is offered, branches are always kept, and a
 * worktree whose commits are not on the default branch is named but never
 * ticked: that one is removed from its own row, on purpose.
 */
export function FreeSpaceDialog({
  open,
  projects,
  onClose,
  onRun,
}: {
  open: boolean
  projects: readonly WorktreeProjectView[]
  onClose: () => void
  onRun: (plan: { remove: WorktreeRow[]; clear: WorktreeRow[] }) => void | Promise<void>
}): React.JSX.Element | null {
  const titleId = useId()
  const plan = useMemo(() => planFreeSpace(projects), [projects])
  const [extra, setExtra] = useState(true)
  const [merged, setMerged] = useState(true)
  const [clear, setClear] = useState(false)
  // Back to the defaults each time it opens, and only then. The plan is
  // rebuilt whenever the page re-reads (every pool change, every store write),
  // and resetting on that would tick again a removal the person had just
  // unticked, under the button they are about to press. A row with nothing in
  // it is never checked, whatever its flag says.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setExtra(true)
      setMerged(true)
      setClear(false)
    }
  }
  if (!open) return null

  const removing = [...(extra ? plan.extraReady : []), ...(merged ? plan.merged : [])]
  const bytes = bytesOf(removing)
  const nothing = removing.length === 0 && !(clear && plan.keptReady.length > 0)

  return (
    <Modal open onClose={onClose} labelledBy={titleId} size="standard">
      <ModalHeader title={copy.settings.worktreesFreeSpaceDialog.freeUpSpace} titleId={titleId} onClose={onClose} />
      <ModalBody>
        <DescribedCheckRowList ariaLabel={copy.settings.worktreesFreeSpaceDialog.whatToRemove}>
          <DescribedCheckRow
            id={`${titleId}-extra`}
            title={copy.settings.worktreesFreeSpaceDialog.removeExtraReadyWorktrees(
              formatBytes(bytesOf(plan.extraReady)),
            )}
            description={
              plan.extraReady.length
                ? copy.settings.worktreesFreeSpaceDialog.theMostRecentOnePer(names(plan.extraReady))
                : copy.settings.worktreesFreeSpaceDialog.noProjectHasMoreThan
            }
            checked={extra && plan.extraReady.length > 0}
            disabled={plan.extraReady.length === 0}
            onChange={setExtra}
          />
          <DescribedCheckRow
            id={`${titleId}-merged`}
            title={copy.settings.worktreesFreeSpaceDialog.removeMergedWorktrees(formatBytes(bytesOf(plan.merged)))}
            description={
              plan.merged.length
                ? copy.settings.worktreesFreeSpaceDialog.cleanOutsideThePoolAlready(names(plan.merged))
                : copy.settings.worktreesFreeSpaceDialog.noCleanMergedWorktreesOutside
            }
            checked={merged && plan.merged.length > 0}
            disabled={plan.merged.length === 0}
            onChange={setMerged}
          />
          <DescribedCheckRow
            id={`${titleId}-clear`}
            title={copy.settings.worktreesFreeSpaceDialog.clearIgnoredFilesInThe}
            description={
              plan.keptReady.length
                ? copy.settings.worktreesFreeSpaceDialog.dependenciesAndBuildOutputThe(names(plan.keptReady))
                : copy.settings.worktreesFreeSpaceDialog.noReadyWorktreeIsKept
            }
            checked={clear && plan.keptReady.length > 0}
            disabled={plan.keptReady.length === 0}
            onChange={setClear}
          />
          {plan.unmerged.length > 0 ? (
            <DescribedCheckRow
              id={`${titleId}-unmerged`}
              title={copy.settings.worktreesFreeSpaceDialog.notMergedNotOffered(formatBytes(bytesOf(plan.unmerged)))}
              description={copy.settings.worktreesFreeSpaceDialog.haveUnmergedCommitsRemoveOne(names(plan.unmerged))}
              checked={false}
              disabled
              onChange={() => {}}
            />
          ) : null}
        </DescribedCheckRowList>
      </ModalBody>
      <ModalFooter>
        <span className="mr-auto text-meta text-[color:var(--text-muted)]">
          {bytes ? `Frees about ${formatBytes(bytes)}` : removing.length ? '' : 'Nothing to remove'}
          {clear && plan.keptReady.length ? `${bytes ? ', ' : 'Frees '}what installs took` : ''}
        </span>
        <GhostButton size="sm" onClick={onClose}>
          {copy.settings.worktreesFreeSpaceDialog.cancel}
        </GhostButton>
        <DangerButton
          size="sm"
          disabled={nothing}
          onClick={() => void onRun({ remove: removing, clear: clear ? plan.keptReady : [] })}
        >
          {bytes ? `Free ${formatBytes(bytes)}` : 'Free up space'}
        </DangerButton>
      </ModalFooter>
    </Modal>
  )
}
