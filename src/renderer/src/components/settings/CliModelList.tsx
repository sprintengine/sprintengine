import React, { useId, useState } from 'react'

import { cliModelListing, type DiscoveredCliModelCatalog } from '../../../../shared/cli-model-catalog'
import type { PluginModelCatalog } from '../../../../shared/plugin-manifest'
import { useRelativeNowFor } from '../../hooks/useRelativeNow'
import { isImeKey } from '../../utils/imeKey'
import {
  CloseIconButton,
  GhostButton,
  InlineNotice,
  Input,
  MicroChip,
  NewChip,
  OutlineButton,
  RefreshIcon,
  Spinner,
} from '../ui'
import { addTypedModel, removeListedModel, restoreListedModel, type CliModelEdit } from './cliModelListEdit'
import { modelDiscoveryLine, modelRefreshProblem, type CliModelRefreshOutcome } from './modelDiscoveryLine'

const EMPTY: string[] = []

/**
 * One CLI's models in Settings ▸ Agents: the list every picker offers, how it
 * got here, and the way to change it. A CLI that will not report its models
 * (a managed install, most often) is still fully usable from here, so the field
 * that takes a typed id is always on the page rather than behind the failure.
 */
export function CliModelList({
  name,
  declared,
  catalog,
  userModels,
  removedModels,
  refreshing,
  outcome,
  selectedModel,
  onRefresh,
  onEdit,
}: {
  name: string
  declared: PluginModelCatalog | undefined
  catalog: DiscoveredCliModelCatalog | undefined
  userModels: string[] | undefined
  removedModels: string[] | undefined
  refreshing: boolean
  /** What the last Refresh found, when it found a problem. */
  outcome: CliModelRefreshOutcome | null
  /** The model new chats on this CLI start with, when one is remembered. */
  selectedModel: string | null
  onRefresh: () => void
  /** A changed list, and the ids that have just left every picker. */
  onEdit: (edit: CliModelEdit, retired: string[]) => void
}): React.JSX.Element {
  const line = (now: number) => modelDiscoveryLine({ name, catalog, refreshing, now })
  const now = useRelativeNowFor(line)
  const fieldId = useId()
  const [draft, setDraft] = useState('')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [removedOpen, setRemovedOpen] = useState(false)
  // Says what a removal did to the next chat, which the row leaving does not.
  const [selectionNote, setSelectionNote] = useState<string | null>(null)

  const edit: CliModelEdit = { models: userModels ?? EMPTY, removedModels: removedModels ?? EMPTY }
  const { listed, removed, reportedIds } = cliModelListing(declared, userModels, catalog, now, removedModels)
  const allowTyping = declared?.allowCustomId === true
  const problem = refreshing ? null : modelRefreshProblem({ name, outcome, catalog, hasRows: listed.length > 0 })

  const add = (): void => {
    const result = addTypedModel(draft, edit, new Set(listed.map((option) => option.id)), name)
    if (!result.ok) {
      setFieldError(result.reason)
      return
    }
    onEdit(result.edit, [])
    setDraft('')
    setFieldError(null)
    setSelectionNote(null)
  }

  const remove = (id: string): void => {
    onEdit(removeListedModel(edit, id, reportedIds), [id])
    setSelectionNote(id === selectedModel ? `New ${name} chats will now use ${name}'s own default model.` : null)
  }

  return (
    <section aria-label={`Models for ${name}`} className="px-3 py-2.5 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-body font-medium text-[color:var(--text-strong)]">
            Models
            {listed.length > 0 ? (
              <span className="ml-1.5 font-normal text-[color:var(--text-subtle)]">{listed.length}</span>
            ) : null}
          </h4>
          <p aria-live="polite" className="mt-0.5 text-meta leading-5 text-[color:var(--text-muted)]">
            {line(now)}
          </p>
        </div>
        <OutlineButton size="xs" disabled={refreshing} onClick={onRefresh} className="shrink-0">
          {refreshing ? <Spinner className="icon-sm" /> : <RefreshIcon className="icon-xs" />}
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </OutlineButton>
      </div>

      {problem ? (
        <InlineNotice tone="warn" title={problem.title} hint={problem.hint} className="mt-2">
          {problem.detail ? (
            <span className="break-words text-meta text-[color:var(--text-muted)]">{problem.detail}</span>
          ) : null}
        </InlineNotice>
      ) : null}

      {listed.length > 0 ? (
        <ul
          aria-label={`${name} models`}
          className="mt-2 divide-y divide-[color:var(--border-subtle)] border-y border-[color:var(--border-subtle)]"
        >
          {listed.map((option) => {
            const label = option.label?.trim()
            return (
              <li key={option.id} className="flex min-h-control-lg items-center gap-2 py-1">
                <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                  <span
                    className={`min-w-0 truncate text-body text-[color:var(--text-default)] ${label ? '' : 'font-mono'}`}
                  >
                    {label || option.id}
                  </span>
                  {label && label !== option.id ? (
                    <span className="min-w-0 truncate font-mono text-meta text-[color:var(--text-subtle)]">
                      {option.id}
                    </span>
                  ) : null}
                </div>
                {option.isNew ? <NewChip /> : null}
                {option.id === selectedModel ? <MicroChip>New chats</MicroChip> : null}
                {option.origin === 'user' ? <MicroChip>Added by you</MicroChip> : null}
                <CloseIconButton
                  size="sm"
                  aria-label={`Remove ${option.id} from ${name} models`}
                  title="Remove from the list"
                  onClick={() => remove(option.id)}
                />
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="mt-2 border-y border-[color:var(--border-subtle)] py-3 text-body text-[color:var(--text-muted)]">
          {allowTyping ? 'No models on the list yet. Type a model id below to add one.' : 'No models on the list.'}
        </p>
      )}

      <div aria-live="polite" className="text-meta leading-5 text-[color:var(--text-muted)] empty:hidden">
        {selectionNote ? <p className="mt-1.5">{selectionNote}</p> : null}
      </div>

      {allowTyping ? (
        <div className="mt-2">
          <div className="flex items-center gap-2">
            <Input
              id={fieldId}
              value={draft}
              aria-label={`Add a model id for ${name}`}
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={fieldError ? `${fieldId}-error` : undefined}
              placeholder="Type a model id"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setDraft(event.target.value)
                setFieldError(null)
              }}
              onKeyDown={(event) => {
                if (isImeKey(event)) return
                if (event.key === 'Enter') {
                  event.preventDefault()
                  add()
                }
              }}
              size="md"
              variant="well"
              fullWidth={false}
              className="min-w-0 flex-1 font-mono"
            />
            <OutlineButton size="md" onClick={add} className="shrink-0">
              Add
            </OutlineButton>
          </div>
          {fieldError ? (
            <p id={`${fieldId}-error`} className="mt-1 text-meta text-[color:var(--tone-error)]">
              {fieldError}
            </p>
          ) : null}
        </div>
      ) : null}

      {removed.length > 0 ? (
        <div className="mt-2">
          <GhostButton
            size="xs"
            aria-expanded={removedOpen}
            onClick={() => setRemovedOpen((open) => !open)}
            className="-ml-2"
          >
            {removedOpen ? 'Hide removed' : `Show removed (${removed.length})`}
          </GhostButton>
          {removedOpen ? (
            <ul aria-label={`Models removed from ${name}`} className="mt-1">
              {removed.map((option) => (
                <li key={option.id} className="flex min-h-control-md items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-body text-[color:var(--text-muted)]">
                    {option.label || <span className="font-mono">{option.id}</span>}
                  </span>
                  <GhostButton
                    size="xs"
                    onClick={() => onEdit(restoreListedModel(edit, option.id), [])}
                    className="-mr-2"
                  >
                    Restore
                    <span className="sr-only">
                      {' '}
                      {option.id} to {name} models
                    </span>
                  </GhostButton>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
