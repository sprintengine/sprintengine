import React from 'react'

import type { SshEnvironmentSummary } from '../../../../../shared/ssh-environments'
import { containerHostWords, NewContainerForm, type ContainerApi } from '../../settings/ContainerMachinesSection'
import { ChipButton, ContainerGlyph, GhostButton, MenuOption, Popover } from '../../ui'
import { ChipCaretGlyph } from './agentSpawnShared'

/**
 * The cube, in the New chat composer's context strip beside Worktree
 * (docs/design/container-chats.md): the front door to containers. A
 * container is a machine, so the chip is another way to pick the chat's
 * machine: it reads the picked container's name, or "No container", and opens
 * a card, "Where this chat runs", listing this computer, every container
 * with the machine it runs on, and New container…, which makes one and picks
 * it. Picking a container here is picking it in the machine picker.
 */
export function ContainerChip({
  containers,
  machines,
  selectedId,
  onSelect,
  onMade,
  api,
}: {
  /** The saved machines that are containers. */
  containers: readonly SshEnvironmentSummary[]
  /** Every saved machine: a container's host is named from them, and New container offers them. */
  machines: readonly SshEnvironmentSummary[]
  /** The container picked as the chat's machine, or null when the chat runs elsewhere. */
  selectedId: string | null
  /** A container picked, or null for this computer. */
  onSelect: (id: string | null) => void
  /** New container made one: pick it, with the folder its clone landed in. */
  onMade: (made: { id: string; folder: string | null }) => void
  api: ContainerApi
}) {
  const [open, setOpen] = React.useState(false)
  const [making, setMaking] = React.useState(false)
  const selected = containers.find((container) => container.id === selectedId) ?? null
  const thisComputer = containerHostWords({ kind: 'local' }, machines)
  const pick = (id: string | null) => {
    onSelect(id)
    setOpen(false)
  }

  return (
    <span data-container-chip={selected ? 'on' : 'off'} className="inline-flex shrink-0 items-center">
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setMaking(false)
        }}
        ariaLabel="Where this chat runs"
        popupRole="dialog"
        placement="bottom-start"
        surfaceClassName={`${making ? 'w-[440px]' : 'w-[300px]'} max-w-[calc(100vw-16px)]`}
        onOpenAutoFocus={(surface) =>
          (
            surface.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ??
            surface.querySelector<HTMLElement>('[role="radio"]')
          )?.focus()
        }
        renderTrigger={({ ref, triggerProps, togglePopover }) => (
          <ChipButton
            ref={ref}
            variant="raised"
            pressed={Boolean(selected)}
            aria-label={selected ? `Container: ${selected.label}` : 'No container'}
            onClick={togglePopover}
            data-container-trigger="true"
            {...triggerProps}
          >
            {/* Still, whatever the container is doing (owner ruling 2026-11-15).
                Off, the mark steps down to disabled ink as Worktree's does. */}
            <ContainerGlyph className={`icon-xs shrink-0${selected ? '' : ' text-[color:var(--text-disabled)]'}`} />
            <span className="max-w-[160px] truncate">{selected ? selected.label : 'No container'}</span>
            <ChipCaretGlyph />
          </ChipButton>
        )}
      >
        <div data-container-card="true" className="flex flex-col gap-1 p-1.5 text-body">
          <div className="px-2 pb-1 pt-1 text-meta font-medium text-[color:var(--text-subtle)]">
            Where this chat runs
          </div>
          <div role="radiogroup" aria-label="Where this chat runs" className="flex flex-col">
            <MenuOption
              role="radio"
              selected={!selected}
              data-container-option="none"
              onClick={() => pick(null)}
              icon={<span aria-hidden="true" className="icon-xs shrink-0" />}
            >
              <span className="block truncate">{thisComputer.replace(/^this/u, 'This')}</span>
            </MenuOption>
            {containers.map((container) => (
              <MenuOption
                key={container.id}
                role="radio"
                stacked
                selected={container.id === selectedId}
                disabled={container.working}
                data-container-option={container.id}
                onClick={() => pick(container.id)}
                icon={<ContainerGlyph className="icon-xs mt-0.5 shrink-0" />}
              >
                <span className="block truncate text-body font-medium">{container.label}</span>
                <span className="block text-meta leading-snug text-[color:var(--text-subtle)]">
                  on {container.container ? containerHostWords(container.container.host, machines) : thisComputer}
                  {container.working ? ` · ${container.stateText}` : ''}
                </span>
              </MenuOption>
            ))}
          </div>
          {making ? (
            <div className="px-2 pb-1 pt-2">
              <NewContainerForm
                api={api}
                machines={machines}
                onMade={(made) => {
                  setMaking(false)
                  setOpen(false)
                  onMade(made)
                }}
              />
            </div>
          ) : (
            <GhostButton size="sm" className="justify-start" onClick={() => setMaking(true)}>
              New container…
            </GhostButton>
          )}
        </div>
      </Popover>
    </span>
  )
}
