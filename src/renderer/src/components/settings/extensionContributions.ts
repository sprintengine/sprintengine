// What an installed extension adds to the app, for its details popover and
// its trust review: read from its extension.json, which declares every panel,
// door, settings section, command, menu item, top bar control and agent tool
// it adds. So the review says what an extension adds before any of its code
// has run, and what it says is what the shell will register on its behalf.

import type { ComponentType } from 'react'

import type { ExtensionManifestView } from '../../../../shared/modules/manifest'
import { extensionGlyph } from '../../modules/extension-glyphs'
import { copy } from '../../../../shared/copy'
import { EXTENSION_PATH_TOKEN } from '../../../../../packages/extension-sdk/src/agent-contributions'

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

/** One thing an extension hands the person's agents or chats, with what the person should see about it. */
export type AgentContributionLine = {
  kind: 'skill' | 'mcp-hosted' | 'mcp-local' | 'provider'
  title: string
  /** What it runs, reaches or sends where, each a line of its own. */
  details: string[]
}

/**
 * The skills, MCP servers and model providers an extension hands agents and
 * chats, as its install review and its details list them: a skill's
 * frontmatter keys agents are not handed (`ignoredSkillKeys`, by skill id), a
 * local server's whole command line and environment, a hosted one's URL, and
 * the origin a provider's key goes to.
 */
export function agentContributionLines(
  extension: Pick<ExtensionManifestView, 'contributes'>,
  ignoredSkillKeys: Readonly<Record<string, readonly string[]>> = {},
): AgentContributionLine[] {
  const t = copy.settings.extensionContributions
  const quoted = (value: string) => (/[\s"']/.test(value) ? JSON.stringify(value) : value)
  const { skills = [], mcpServers = [], providers = [] } = extension.contributes
  const lines: AgentContributionLine[] = []
  for (const skill of skills) {
    const ignored = Object.hasOwn(ignoredSkillKeys, skill.id) ? (ignoredSkillKeys[skill.id] ?? []) : []
    lines.push({
      kind: 'skill',
      title: t.skill(skill.id),
      details: ignored.length > 0 ? [t.ignoredKeys(ignored.join(', '))] : [],
    })
  }
  for (const server of mcpServers) {
    if (server.transport === 'http') {
      lines.push({ kind: 'mcp-hosted', title: t.hostedMcpServer(server.name), details: [t.reaches(server.url ?? '')] })
      continue
    }
    const parts = [server.command ?? '', ...(server.args ?? [])]
    const env = (server.env ?? []).map((variable) => `${variable.name}=${quoted(variable.value)}`)
    const usesFolder = [...parts, ...env].some((part) => part.includes(EXTENSION_PATH_TOKEN))
    lines.push({
      kind: 'mcp-local',
      title: t.localMcpServer(server.name),
      details: [
        t.runs(parts.map(quoted).join(' ')),
        ...(env.length > 0 ? [t.withEnvironment(env.join(' '))] : []),
        ...(usesFolder ? [t.extensionPathMeans(EXTENSION_PATH_TOKEN)] : []),
      ],
    })
  }
  for (const provider of providers) {
    let origin = provider.baseUrl
    try {
      origin = new URL(provider.baseUrl).origin
    } catch {
      // Shown as written: the manifest was validated where it was installed.
    }
    lines.push({
      kind: 'provider',
      title: t.provider(provider.name),
      details: [provider.apiKey ? t.keySentTo(origin) : t.noKey(origin)],
    })
  }
  return lines
}
