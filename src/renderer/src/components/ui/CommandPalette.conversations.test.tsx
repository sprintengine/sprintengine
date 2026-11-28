// @vitest-environment jsdom
//
// The Conversations results: one row per chat, the sentence that matched
// under its title with the query marked in it, no row left over from an
// earlier keystroke, the agent's mark only where chats share the list with
// other kinds of result, and the blurred scrim over a conversation.
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ConversationSearchHit, ConversationSearchResult } from '../../../../shared/conversation-index'
import type { BranchPullRequest } from '../../../../shared/git/pull-request'
import type { Workspace, WorkspaceId, WorkspaceWindowId } from '../../../../shared/workspace'
import type { ModuleCommandContext } from '../../commands/types'
import type { CommandAvailabilityContext } from '../../commands/availability'
import type { PaletteScope } from '../commandPaletteSearch'
import type { RemoteSessionOpenSpec } from '../workspace/remoteBand/remoteSessionsModel'

const fixtures = vi.hoisted(() => ({
  state: {
    activeWorkspaceId: 'ws-1',
    focusedAgentByWorkspaceId: {} as Record<string, string>,
    pluginCatalogEntries: [],
    appSettings: { keybindings: {}, modules: {}, appearance: { usageLimits: false } },
    workspaces: [] as unknown[],
    setActiveWorkspaceForWindow: () => {},
    setActiveFile: () => {},
    openExtensionsSurface: () => {},
  },
  pullRequests: {} as Record<string, BranchPullRequest[]>,
  environmentRows: [] as unknown[],
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
// Other environments' chats, as their environments list them.
vi.mock('../workspace/remoteBand/useEnvironmentChatRows', () => ({
  useEnvironmentChatRows: () => fixtures.environmentRows,
}))
vi.mock('../workspace/useConversationPullRequests', () => ({
  useConversationPullRequests: () => fixtures.pullRequests,
}))

import CommandPalette from './CommandPalette'
import { installStudioLoopback } from '../../../../../tests/studio-chat-loopback'
vi.mock('../../studio/agentSkills', () => import('../../studio/agentSkills.double'))

const chatAgent = {
  agent: { id: 'agent', name: 'Art Shea', runtimeKind: 'conversation', conversation: { providerId: 'claude-agent' } },
}
const workspaces = [
  { id: 'ws-1', name: 'Pull requests to land', mode: 'standard', folderPath: '/Users/dev/studio', agents: chatAgent },
  {
    id: 'ws-2',
    name: 'Fix open issues for production',
    mode: 'standard',
    folderPath: '/Users/dev/.sprintengine-worktrees/app/pool-08',
    worktree: { branch: 'agent/scheduled', baseRef: 'HEAD', repoRoot: '/Users/dev/app' },
    agents: chatAgent,
  },
  { id: 'ws-3', name: 'Forecast page', mode: 'standard', folderPath: '/Users/dev/app', agents: chatAgent },
] as unknown as Workspace[]

const hit = (seq: number, snippet: string, from: ConversationSearchHit['from']): ConversationSearchHit => ({
  agentId: 'agent',
  seq,
  snippet,
  from,
})

// The searches in flight, by query and chat, so a test decides when each answers.
type Pending = { workspaceId: string; query: string; resolve: (result: ConversationSearchResult) => void }
let pending: Pending[] = []
const conversationSearch = vi.fn(
  (input: { workspaceId: string; query: string }) =>
    new Promise<ConversationSearchResult>((resolve) => {
      pending.push({ workspaceId: input.workspaceId, query: input.query, resolve })
    }),
)
async function answer(query: string, hits: Record<string, ConversationSearchHit[]>) {
  // The chats are searched one at a time, so each answer lets the next start.
  for (let step = 0; step < workspaces.length; step += 1) {
    const next = pending.find((entry) => entry.query === query)
    if (!next) break
    pending = pending.filter((entry) => entry !== next)
    await act(async () => {
      next.resolve({ ok: true, hits: hits[next.workspaceId] ?? [] })
      await vi.advanceTimersByTimeAsync(0)
    })
  }
}

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  pending = []
  fixtures.state.workspaces = workspaces
  fixtures.environmentRows = []
  fixtures.pullRequests = {
    'ws-2': [
      {
        url: 'https://github.com/acme/app/pull/79',
        repoKey: 'github.com/acme/app',
        repoName: 'app',
        number: 79,
        title: 'Read wave directions from open water',
        state: 'open',
        isDraft: false,
        openedAt: 1,
        stateAt: 1,
      },
    ],
  }
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
      conversationSearch,
    },
  })
  // History is searched by the window's Studio, over the protocol
  // (`conversation.searchChats`), in each chat it holds.
  installStudioLoopback(window as never, {
    searchableChats: () =>
      workspaces.map((workspace) => ({
        workspaceId: workspace.id,
        workspaceRoot: workspace.folderPath!,
        chatTitle: workspace.name,
      })),
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  document.body.innerHTML = ''
  vi.useRealTimers()
})

async function render(
  initialScope: PaletteScope = 'conversations',
  options: { workspaces?: Workspace[]; onOpenEnvironmentChat?: (spec: RemoteSessionOpenSpec) => string | null } = {},
) {
  await act(async () =>
    root.render(
      <CommandPalette
        onClose={() => {}}
        onRunCommand={() => false}
        onOpenRemoteConnections={() => {}}
        {...(options.onOpenEnvironmentChat ? { onOpenEnvironmentChat: options.onOpenEnvironmentChat } : {})}
        workspaceWindowId={'window-1' as WorkspaceWindowId}
        workspaces={options.workspaces ?? workspaces}
        activeWorkspaceId={'ws-1' as WorkspaceId}
        activeScopes={[]}
        commandAvailability={{} as CommandAvailabilityContext}
        moduleCommandContext={{} as ModuleCommandContext}
        initialScope={initialScope}
      />,
    ),
  )
}
const field = () => host.querySelector<HTMLInputElement>('input[role="combobox"]')!
const options = () => Array.from(host.querySelectorAll<HTMLElement>('[role="option"]'))
const row = (title: string) => options().find((option) => option.textContent?.includes(title))
async function type(value: string) {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setValue.call(field(), value)
    field().dispatchEvent(new Event('input', { bubbles: true }))
  })
  // Past the search's pause.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })
}

test('each chat is one row: the sentence that matched under its title, the query marked, the project beside it', async () => {
  await render()
  await type('wave')
  await answer('wave', {
    'ws-1': [hit(3, 'is the wave model right?', 'person'), hit(3, 'The wave model is right.', 'agent')],
    'ws-3': [hit(8, 'Agent text about a wave', 'agent'), hit(5, 'I mentioned the wave forecast here', 'person')],
  })

  // Every chat the sidebar lists was searched, not only the open one.
  expect(conversationSearch.mock.calls.map(([input]) => input.workspaceId).sort()).toEqual(['ws-1', 'ws-2', 'ws-3'])
  expect(options()).toHaveLength(3)
  const ids = options().map((option) => option.id)
  expect(new Set(ids).size).toBe(ids.length)

  const forecast = row('Forecast page')!
  expect(forecast.textContent).toContain('You:')
  expect(forecast.textContent).toContain('I mentioned the wave forecast here')
  expect(forecast.textContent).toContain('+1 more')
  expect(Array.from(forecast.querySelectorAll('mark')).map((mark) => mark.textContent)).toEqual(['wave'])
  // The project by name, never the path.
  expect(forecast.textContent).toContain('app')
  expect(forecast.textContent).not.toContain('/Users/dev')

  // Found by its pull request's title: the line says so, with the number quiet beside the title.
  const issues = row('Fix open issues for production')!
  expect(issues.textContent).toContain('#79 Read wave directions from open water')
  expect(issues.querySelector('[aria-label="Pull request 79"]')).not.toBeNull()
  // The worktree's project, not its slot.
  expect(issues.textContent).toContain('app')
  expect(issues.textContent).not.toContain('pool-08')
})

test('rows from an earlier keystroke that do not hold the new query leave at once', async () => {
  await render()
  await type('wa')
  await answer('wa', {
    'ws-1': [hit(1, 'wait for the checks', 'person')],
    'ws-3': [hit(2, 'the wave forecast', 'person')],
  })
  // The two chats that said it, and the one whose pull request's title has it.
  expect(options()).toHaveLength(3)
  expect(row('Pull requests to land')?.textContent).toContain('wait for the checks')

  // The search for "wave" is in flight: the "wait" row is not a match for it,
  // and leaves now rather than when the search answers.
  await type('wave')
  expect(row('Pull requests to land')).toBeUndefined()
  expect(row('Forecast page')?.textContent).toContain('the wave forecast')
  await answer('wave', { 'ws-3': [hit(2, 'the wave forecast', 'person')] })
  expect(options()).toHaveLength(2)
})

test('the agent’s mark leads a chat in the All tab and not in the Conversations tab', async () => {
  const chip = (option: HTMLElement) => option.querySelector('.rounded-full')
  await render('conversations')
  await type('forecast')
  await answer('forecast', {})
  expect(row('Forecast page')).toBeDefined()
  expect(chip(row('Forecast page')!)).toBeNull()

  await act(async () => root.unmount())
  root = createRoot(host)
  await render('all')
  await type('forecast')
  await answer('forecast', {})
  expect(chip(row('Forecast page')!)).not.toBeNull()
  // A chat tab's agent, not the workspace type's terminal glyph.
  expect(chip(row('Forecast page')!)?.querySelector('svg, img')).not.toBeNull()
})

test('the scrim blurs over a conversation and keeps its plain tone over a terminal', async () => {
  const pane = (attribute: string) => {
    const element = document.createElement('div')
    element.setAttribute(attribute, '')
    Object.assign(element, { checkVisibility: () => true })
    document.body.prepend(element)
    return element
  }
  const scrim = () => host.querySelector('.overlay-scrim')!
  const chat = pane('data-chat-pane')
  await render()
  expect(scrim().classList.contains('scrim-glass')).toBe(true)

  await act(async () => root.unmount())
  root = createRoot(host)
  pane('data-terminal-surface')
  await render()
  expect(scrim().classList.contains('scrim-glass')).toBe(false)
  chat.remove()
})

// Another environment's chat is a row of its own, by its address, from what
// its environment lists; a record this window keeps of one (an SSH copy, a
// paired chat attached here) is not a second row of it.
test("another environment's chat is one row from its environment's list, and a record here of it is none", async () => {
  fixtures.environmentRows = [
    {
      key: 'env-ssh:rw1',
      route: 'ssh:build-box',
      environmentId: 'env-ssh',
      connectionId: null,
      machineName: 'build-box',
      title: 'Tide tables',
      workspaceId: 'rw1',
      workspaceRoot: '/home/dev/.sprintengine-worktrees/harbour/pool-02',
      projectFolder: '/home/dev/harbour',
      repository: null,
      agents: [],
      attachedWorkspaceId: 'ws-copy',
    },
  ]
  const copy = {
    id: 'ws-copy',
    name: 'Tide tables',
    mode: 'standard',
    folderPath: '/home/dev/harbour',
    environment: { kind: 'ssh', id: 'build-box', label: 'build-box' },
    agents: chatAgent,
  } as unknown as Workspace
  const opened: RemoteSessionOpenSpec[] = []
  await render('conversations', {
    workspaces: [...workspaces, copy],
    onOpenEnvironmentChat: (spec) => {
      opened.push(spec)
      return 'ws-copy'
    },
  })
  await type('tide')
  const rows = options().filter((option) => option.textContent?.includes('Tide tables'))
  expect(rows).toHaveLength(1)
  expect(rows[0]!.id).toBe('palette-option-switch-env-ssh:rw1')
  // Its project there, not its slot.
  expect(rows[0]!.textContent).toContain('harbour')
  expect(rows[0]!.textContent).not.toContain('pool-02')
  await act(async () => rows[0]!.click())
  expect(opened.map((spec) => [spec.route, spec.chatId, spec.attachedWorkspaceId])).toEqual([
    ['ssh:build-box', 'rw1', 'ws-copy'],
  ])
})
