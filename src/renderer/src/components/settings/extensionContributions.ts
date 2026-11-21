// What an installed extension adds to the app, for its details popover and
// its trust review: read from its extension.json, which declares every panel,
// door, settings section, command, menu item, top bar control and agent tool
// it adds. So the review says what an extension adds before any of its code
// has run, and what it says is what the shell will register on its behalf.

import type { ComponentType } from 'react'

import type { ExtensionManifestView } from '../../../../shared/modules/manifest'
import { extensionGlyph } from '../../modules/extension-glyphs'
import { copy } from '../../../../shared/copy'

export type ContributionKind = 'door' | 'panel' | 'command' | 'settings' | 'top-bar' | 'action' | 'tools'

export type ExtensionContribution = { kind: ContributionKind; label: string }

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** What the extension's manifest adds, or null when it adds nothing. */
export function deriveContributions(
  extension: Pick<ExtensionManifestView, 'contributes'>,
): ExtensionContribution[] | null {
  const { contributes } = extension
  const adds: ExtensionContribution[] = []
  for (const door of contributes.doors) {
    adds.push({ kind: 'door', label: copy.settings.extensionContributions.door2(door.title) })
  }
  for (const panel of contributes.panels) adds.push({ kind: 'panel', label: `${panel.title} panel` })
  for (const section of contributes.settingsSections) {
    adds.push({ kind: 'settings', label: copy.settings.extensionContributions.settings(section.title) })
  }
  const topBar = contributes.topBarItems.length
  if (topBar > 0) adds.push({ kind: 'top-bar', label: count(topBar, 'top-bar control', 'top-bar controls') })
  const commands = contributes.commands.length
  if (commands > 0) adds.push({ kind: 'command', label: count(commands, 'command', 'commands') })
  const backlog = contributes.menus.filter((menu) => menu.where === 'backlog.item').length
  if (backlog > 0) adds.push({ kind: 'action', label: count(backlog, 'Backlog action', 'Backlog actions') })
  const files = contributes.menus.filter((menu) => menu.where === 'file').length
  if (files > 0) adds.push({ kind: 'action', label: count(files, 'file action', 'file actions') })
  const tools = contributes.mcpTools.length
  if (tools > 0) adds.push({ kind: 'tools', label: count(tools, 'agent tool', 'agent tools') })
  return adds.length > 0 ? adds : null
}

/** The glyph an extension's row wears: its first door's, else its first panel's. */
export function moduleDoorIcon(
  extension: Pick<ExtensionManifestView, 'contributes'>,
): ComponentType<{ className?: string }> | null {
  const surface = extension.contributes.doors[0] ?? extension.contributes.panels[0]
  return surface ? extensionGlyph(surface.icon) : null
}
