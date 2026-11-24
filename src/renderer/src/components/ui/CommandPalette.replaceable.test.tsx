// @vitest-environment jsdom
//
// Every palette row for an action an extension may take over runs through the
// shell's runner (`onRunCommand`, which is `runPersonCommand` in the window),
// so a replacement runs from the palette as it does from the shortcut. The
// Git panel's Refresh and Fetch rows used to reach the panel directly.
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Workspace, WorkspaceId, WorkspaceWindowId } from '../../../../shared/workspace'
import type { ModuleCommandContext } from '../../commands/types'
import type { CommandAvailabilityContext } from '../../commands/availability'

const fixtures = vi.hoisted(() => ({
  state: {
    activeWorkspaceId: 'ws-1',
    focusedAgentByWorkspaceId: {} as Record<string, string>,
    pluginCatalogEntries: [],
    appSettings: { keybindings: {}, modules: {}, appearance: { usageLimits: false } },
    setActiveWorkspaceForWindow: () => {},
    setActiveFile: () => {},
    openExtensionsSurface: () => {},
  },
}))
vi.mock('../../store/workspaceStore', () => {
  const useWorkspaceStore = (select: (state: typeof fixtures.state) => unknown) => select(fixtures.state)
  useWorkspaceStore.getState = () => fixtures.state
  return { useWorkspaceStore }
})
vi.mock('../../modules', async () => {
  const { createRendererHost } = await import('../../modules/renderer-host')
  const host = createRendererHost()
  return { getRendererHost: () => host, selectModuleEnabled: () => true }
})
vi.mock('../../hooks/useTerminalSessions', () => ({
  useTerminalSessions: () => [],
  isLiveTerminal: () => false,
}))
vi.mock('../workspace/useConversationPullRequests', () => ({ useConversationPullRequests: () => ({}) }))
vi.mock('../../studio/agentSkills', () => import('../../studio/agentSkills.double'))
const dispatched = vi.hoisted(() => [] as string[])
vi.mock('../../utils/panelCommands', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/panelCommands')>()),
  dispatchPanelCommandEvent: (id: string) => dispatched.push(id),
}))

import CommandPalette from './CommandPalette'
import { resetScheduledAgentsStoreForTests } from '../../store/scheduledAgentsStore'
import { forgetExtensionReplacements, registerExtensionReplacement } from '../../modules/extension-replacements'
import { runReplaceable } from '../../modules/extension-replacements'

const workspace = {
  id: 'ws-1',
  name: 'project',
  mode: 'agent',
  folderPath: '/Users/dev/project',
} as unknown as Workspace

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  vi.clearAllMocks()
  dispatched.length = 0
  resetScheduledAgentsStoreForTests()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  HTMLElement.prototype.scrollIntoView = vi.fn()
  Object.assign(window, {
    api: {
      platform: 'darwin',
      builtinSkillsList: async () => [],
      workspaceSkillsList: async () => ({ ok: true, skills: [] }),
      searchFiles: async () => ({ ok: true, results: [], engine: 'ripgrep' }),
      searchContent: async () => ({ ok: true, results: [], engine: 'ripgrep' }),
      cancelContentSearch: async () => {},
      readfile: async () => '',
      listScheduledAgents: async () => [],
      onScheduledAgentsChanged: () => () => {},
      getScheduledAgentsPause: async () => null,
      onScheduledAgentsPauseChanged: () => () => {},
    },
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  forgetExtensionReplacements('acme.fetch')
  await act(async () => root.unmount())
  host.remove()
})

async function render(onRunCommand: (id: string) => boolean) {
  await act(async () =>
    root.render(
      <CommandPalette
        onClose={() => {}}
        onRunCommand={onRunCommand}
        onOpenRemoteConnections={() => {}}
        workspaceWindowId={'window-1' as WorkspaceWindowId}
        workspaces={[workspace]}
        activeWorkspaceId={'ws-1' as WorkspaceId}
        activeScopes={['workspace']}
        commandAvailability={{ activeWorkspace: true, gitPanelActive: true } as unknown as CommandAvailabilityContext}
        moduleCommandContext={{} as ModuleCommandContext}
      />,
    ),
  )
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function choose(text: string) {
  const field = host.querySelector<HTMLInputElement>('input[role="combobox"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const option = Array.from(host.querySelectorAll<HTMLElement>('[role="option"]')).find((row) =>
    (row.textContent ?? '').toLowerCase().includes(text.toLowerCase()),
  )
  expect(option, text).toBeDefined()
  await act(async () => option!.click())
}

test('the palette’s Fetch and Refresh go through the shell’s runner, so an approved replacement runs', async () => {
  const operated: string[] = []
  registerExtensionReplacement({
    key: 'acme.fetch',
    commandId: 'acme.fetch-all',
    title: 'Fetch every remote',
    action: 'git.fetch',
    host: {
      getActiveWorkspaceId: () => 'ws-1',
      methods: () =>
        ({
          operate: async (method: string) => {
            operated.push(method)
            return { ok: true, result: null }
          },
        }) as never,
    },
    live: () => true,
  })
  const ran: string[] = []
  // As the window wires it: the person's command, replaced when an extension takes it over.
  await render((id) => {
    ran.push(id)
    return runReplaceable(id, () => {
      dispatched.push(id)
      return true
    })
  })
  await choose('Fetch remotes')
  await vi.waitFor(() => expect(operated).toEqual(['acme.fetch-all']))
  expect(ran).toEqual(['git.fetch'])
  expect(dispatched).toEqual([])

  await render((id) => {
    ran.push(id)
    return runReplaceable(id, () => {
      dispatched.push(id)
      return true
    })
  })
  await choose('Refresh status')
  expect(ran.at(-1)).toBe('git.refresh')
  // Nothing replaces refresh: Studio's own reaches the Git panel.
  expect(dispatched).toEqual(['git.refresh'])
})
