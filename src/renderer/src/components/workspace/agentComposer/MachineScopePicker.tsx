import React from 'react'

import type { MachineRef } from '../../../../../shared/machine-identity'
import {
  environmentKey,
  environmentOnThisComputer,
  environmentRouteOf,
  type EnvironmentEntry,
} from '../../../../../shared/environments'
import { useMachineIdentity } from '../../../hooks/useMachineIdentity'
import { RemoteMachineGlyph } from '../../AppIcons'
import { ChipButton, MachineGlyph, MENU_LIST_CLASS, MenuOption, Popover } from '../../ui'
import { MENU_GROUP_LABEL_CLASS } from '../../ui/menuClasses'
import { ChipCaretGlyph, menuRadioRowKeyDown } from './agentSpawnShared'
import type { MachineAvailability } from './newChatMachines'
import { copy as appCopy } from '../../../../../shared/copy'

/**
 * A machine's mark in a menu row's leading slot, or the empty slot the width of
 * one for this computer, which wears none (owner ruling 2026-10-04).
 */
function MachineSlot({ machine, className = 'icon-xs shrink-0' }: { machine: MachineRef; className?: string }) {
  const identity = useMachineIdentity(machine)
  return identity ? (
    <MachineGlyph identity={identity} className={className} />
  ) : (
    <span aria-hidden="true" className={className} />
  )
}

/** The trigger's mark: the picked machine's, and nothing for this computer. */
function TriggerMachineMark({ machine }: { machine: MachineRef }) {
  const identity = useMachineIdentity(machine)
  return identity ? <MachineGlyph identity={identity} /> : null
}

/**
 * The machine a scheduled agent runs on, as a line and not a choice: one
 * being edited stays on the machine it was saved on. Drawn as the trigger is,
 * its mark and its name, so the strip reads the same.
 */
export function FixedMachineLine({ machineName, machine }: { machineName: string; machine: MachineRef | null }) {
  return (
    <span
      data-machine-line="true"
      className="inline-flex h-control-xs min-w-0 items-center gap-1.5 px-2 text-meta text-[color:var(--text-subtle)]"
    >
      {machine ? <TriggerMachineMark machine={machine} /> : null}
      <span className="min-w-0 truncate">{machineName}</span>
    </span>
  )
}

/**
 * The machine dropdown (remote-sessions-ux / new-chat-on-a-remote-machine,
 * design-environments PR 2): one list of environments, whatever kind of
 * machine each is. This computer leads it and is the default; its WSL
 * distributions follow it (owner decision 2026-09-24), then every other
 * machine under "Other machines", alphabetically, each wearing its own mark
 * (owner ruling 2026-10-04): an order that never moves with reachability. One
 * dropdown: the owner rejected a separate Local/Remote switch as redundant.
 * With nothing on this computer but itself, its row is the "This device" it
 * always was.
 *
 * A row that cannot be picked now (`reasonOf`: not answering, refused this
 * computer, a Studio this app cannot speak to, a folder it cannot open) stays
 * in the list, dimmed, with the reason as its second line.
 */
export function MachineScopePicker({
  environments,
  selectedRoute,
  onSelect,
  reasonOf,
  availability,
  onOpen,
  projectName,
}: {
  /** Every machine to offer, in `orderEnvironmentsForPicking` order. */
  environments: readonly EnvironmentEntry[]
  /** The picked machine's route (`environmentRouteOf`). */
  selectedRoute: string
  onSelect: (environment: EnvironmentEntry) => void
  /** Why a machine cannot be picked right now, or null. */
  reasonOf?: (environment: EnvironmentEntry) => string | null
  /** Whether each machine holds the project in hand (one-project-across-machines); `none` lists it plainly. */
  availability?: (environment: EnvironmentEntry) => MachineAvailability
  onOpen?: () => void
  /** The project in hand, named in the rows' lines. */
  projectName?: string | null
}) {
  const [open, setOpen] = React.useState(false)
  const rowKey = (event: React.KeyboardEvent<HTMLButtonElement>, activate: () => void) =>
    menuRadioRowKeyDown(event, '[data-machine-option="true"]', activate)
  const here = environments.filter(environmentOnThisComputer)
  const away = environments.filter((environment) => !environmentOnThisComputer(environment))
  const selected = environments.find((environment) => environmentRouteOf(environment) === selectedRoute) ?? null
  // With nothing else on this computer, this machine is the plain "This device".
  const nameOf = (environment: EnvironmentEntry): string =>
    here.length <= 1 && environmentRouteOf(environment) === 'local'
      ? appCopy.workspace.agentComposer.machineScopePicker.thisDevice
      : environment.displayName
  const focusChecked = React.useCallback((surface: HTMLElement) => {
    const target =
      surface.querySelector<HTMLButtonElement>('[data-machine-option="true"][aria-checked="true"]:not([disabled])') ??
      surface.querySelector<HTMLButtonElement>('[data-machine-option="true"]:not([disabled])')
    target?.focus()
    if (target && document.activeElement !== target) {
      requestAnimationFrame(() => {
        if (surface.isConnected) target.focus()
      })
    }
  }, [])
  const row = (environment: EnvironmentEntry) => {
    const route = environmentRouteOf(environment)
    const reason = reasonOf?.(environment) ?? null
    const state = availability?.(environment) ?? { state: 'none' as const }
    const pickable = !reason && state.state !== 'lacks' && state.state !== 'unreachable'
    const isSelected = route === selectedRoute
    const activate = () => {
      if (!pickable) return
      onSelect(environment)
      setOpen(false)
    }
    // With a project in hand the row says whether the machine has it: a
    // copy's name when it does, the reason when it does not (dimmed, kept in
    // the list: the menu spec's rule for a row that cannot be chosen).
    const hint =
      reason ??
      (state.state === 'has'
        ? `Has ${projectName ?? 'the project'}${state.workspace.folderPath ? ` at ${state.workspace.folderPath}` : ''}`
        : state.state === 'lacks' || state.state === 'unreachable'
          ? state.reason
          : state.state === 'loading'
            ? 'Asking what it holds…'
            : null)
    return (
      <MenuOption
        key={environmentKey(environment)}
        role="menuitemradio"
        selected={isSelected}
        stacked={Boolean(hint)}
        disabled={!pickable}
        data-machine-option="true"
        data-machine-route={route}
        data-machine-availability={state.state}
        tabIndex={isSelected ? 0 : -1}
        onKeyDown={(event) => rowKey(event, activate)}
        onClick={activate}
        icon={<MachineSlot machine={environment.machine} className={`icon-xs shrink-0${hint ? ' mt-0.5' : ''}`} />}
      >
        <span className={hint ? 'block truncate text-body font-medium' : 'block truncate'}>{nameOf(environment)}</span>
        {hint ? <span className="block text-meta leading-snug text-[color:var(--text-subtle)]">{hint}</span> : null}
      </MenuOption>
    )
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) onOpen?.()
      }}
      ariaLabel={appCopy.workspace.agentComposer.machineScopePicker.machineThisChatRunsOn}
      popupRole="menu"
      placement="bottom-start"
      surfaceClassName={`w-[280px] ${MENU_LIST_CLASS}`}
      onOpenAutoFocus={focusChecked}
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        // The kit's quiet chip, the context strip's control (owner ruling
        // 2026-10-04): the machine's own mark, its name and the caret.
        <ChipButton ref={ref} variant="raised" onClick={togglePopover} data-machine-trigger="true" {...triggerProps}>
          <TriggerMachineMark machine={selected?.machine ?? { kind: 'local' }} />
          {selected ? nameOf(selected) : appCopy.workspace.agentComposer.machineScopePicker.thisDevice}
          <ChipCaretGlyph />
        </ChipButton>
      )}
    >
      {/* The surface is the menu; these are its rows. The leading slot is
          all-or-nothing per the menu spec, so this computer renders an empty
          slot the width of the machine glyph rather than sliding its label left. */}
      {here.map(row)}
      {/* Every machine not on this computer, under the one mark that means
          "another machine" in general. */}
      {away.length > 0 ? (
        <div className={`${MENU_GROUP_LABEL_CLASS} flex items-center gap-1.5 pb-1 pt-2`}>
          <RemoteMachineGlyph className="icon-xs shrink-0" />
          {appCopy.workspace.agentComposer.machineScopePicker.otherMachines}
        </div>
      ) : null}
      {away.map(row)}
    </Popover>
  )
}
