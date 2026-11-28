import React from 'react'

import { Select, Tooltip } from '../ui'
import { sameSelection, type StripEntry } from './branchSteps'
import type { BranchStepSelection } from '../../../../shared/electron-api'
import { copy } from '../../../../shared/copy'

// Which part of the branch the diff shows: the whole branch, the uncommitted
// tail, or one commit, oldest first — the order the work happened in. One
// select at the top of the files column (2026-11-28). It was a row of chips
// across the top of the viewer, which read as a second tab strip over the
// diff and pushed the code a band further down for a choice made now and then.

/** The text a step reads as in the select: a commit's short hash before its subject. */
export function branchStepLabel(entry: StripEntry): string {
  return entry.hash ? `${entry.hash} ${entry.label}` : entry.label
}

export function BranchStepPicker({
  entries,
  selection,
  onSelect,
  note,
  className,
}: {
  entries: StripEntry[]
  selection: BranchStepSelection
  onSelect: (selection: BranchStepSelection) => void
  /** What this checkout may honestly claim, when it is not simply this chat's. */
  note: string | null
  className?: string
}) {
  // A select with one option offers no choice, so it is not drawn.
  const choosing = entries.length > 1
  if (!choosing && !note) return null
  const selected = entries.find((entry) => sameSelection(entry.selection, selection)) ?? entries[0] ?? null

  return (
    <div className={`flex min-w-0 items-center gap-1.5 ${className ?? ''}`}>
      {choosing ? (
        <Select
          size="xs"
          ariaLabel={copy.auxWindows.branchStepPicker.branchSteps}
          className="min-w-0 flex-1"
          triggerMinWidthClassName="min-w-0"
          items={entries.map((entry) => ({ value: entry.key, label: branchStepLabel(entry) }))}
          value={selected?.key ?? null}
          onChange={(key) => {
            const entry = entries.find((candidate) => candidate.key === key)
            if (entry) onSelect(entry.selection)
          }}
        />
      ) : null}
      {note ? (
        // Whose changes these are, when the checkout cannot say they are this
        // chat's alone: a mark beside the select, the sentence in its tooltip.
        <Tooltip content={note} placement="bottom">
          <span
            role="img"
            aria-label={note}
            tabIndex={0}
            className="inline-flex size-control-xs shrink-0 items-center justify-center rounded-sm text-[color:var(--text-muted)] hover:text-[color:var(--text-default)] focus-visible:focus-ring"
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="icon-xs">
              <path d="M8 1.5 15 14H1L8 1.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
              <path d="M8 6.5v3M8 11.6v.01" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </span>
        </Tooltip>
      ) : null}
    </div>
  )
}
