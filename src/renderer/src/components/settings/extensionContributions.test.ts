import { expect, test } from 'vitest'

import type { ExtensionManifestView } from '../../../../shared/modules/manifest'
import { ChatGlyph, ExtensionsGlyph, ReleaseNotesIcon } from '../AppIcons'
import { deriveContributions, moduleDoorIcon } from './extensionContributions'

type Contributes = ExtensionManifestView['contributes']

function contributes(over: Partial<Contributes> = {}): Pick<ExtensionManifestView, 'contributes'> {
  return {
    contributes: {
      commands: [],
      menus: [],
      topBarItems: [],
      panels: [],
      doors: [],
      settingsSections: [],
      mcpTools: [],
      hooks: [],
      syntaxes: [],
      customEditors: [],
      keybindings: [],
      statusBarItems: [],
      settings: [],
      ...over,
    },
  }
}

test('what an extension adds is read off its extension.json, before any of its code runs', () => {
  expect(
    deriveContributions(
      contributes({
        doors: [{ id: 'radar', title: 'PR Radar', icon: 'chat', entry: 'dist/radar.js' }],
        panels: [{ id: 'queue', title: 'Review queue', entry: 'dist/queue.js' }],
        settingsSections: [{ id: 'prefs', title: 'PR Radar', entry: 'dist/prefs.js' }],
        topBarItems: [{ id: 'open', title: 'Open radar', door: 'radar' }],
        commands: [
          { id: 'radar.refresh', title: 'Refresh' },
          { id: 'radar.backlog', title: 'Open Backlog', action: 'panel.backlog.toggle' },
        ],
        menus: [
          { where: 'backlog.item', command: 'radar.refresh' },
          { where: 'file', command: 'radar.refresh' },
          { where: 'file', command: 'radar.backlog' },
          { where: 'notification', command: 'radar.refresh' },
        ],
        mcpTools: [
          { name: 'radar_list', description: 'List.', access: 'read' },
          { name: 'radar_mark', description: 'Mark.', access: 'operate' },
        ],
      }),
    ),
  ).toEqual([
    { kind: 'door', label: 'PR Radar door' },
    { kind: 'panel', label: 'Review queue panel' },
    { kind: 'settings', label: 'PR Radar settings' },
    { kind: 'top-bar', label: '1 top-bar control' },
    { kind: 'command', label: '2 commands' },
    { kind: 'action', label: '1 Backlog action' },
    { kind: 'action', label: '2 file actions' },
    { kind: 'tools', label: '2 agent tools' },
  ])
})

test('an extension that declares nothing adds nothing, said as null', () => {
  expect(deriveContributions(contributes())).toBeNull()
  expect(
    deriveContributions(contributes({ mcpTools: [{ name: 'worker_run', description: 'Run.', access: 'read' }] })),
  ).toEqual([{ kind: 'tools', label: '1 agent tool' }])
})

test('the row wears its first door’s glyph, else its first panel’s, else none', () => {
  expect(
    moduleDoorIcon(
      contributes({
        doors: [{ id: 'radar', title: 'PR Radar', icon: 'chat', entry: 'dist/radar.js' }],
        panels: [{ id: 'notes', title: 'Notes', icon: 'notes', entry: 'dist/notes.js' }],
      }),
    ),
  ).toBe(ChatGlyph)
  expect(moduleDoorIcon(contributes({ panels: [{ id: 'notes', title: 'Notes', icon: 'notes', entry: 'n.js' }] }))).toBe(
    ReleaseNotesIcon,
  )
  expect(moduleDoorIcon(contributes({ doors: [{ id: 'plain', title: 'Plain', entry: 'p.js' }] }))).toBe(ExtensionsGlyph)
  expect(moduleDoorIcon(contributes({ commands: [{ id: 'x', title: 'X', action: 'chat.new' }] }))).toBeNull()
})
