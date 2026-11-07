// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { ConversationChangedFileSides } from '../../../../../packages/conversation-protocol/src/checkoutChanges'
import type { BranchStepDiff, BranchStepSelection } from '../../../../shared/electron-api'
import { registerMountedChatView } from '../panels/agentChat/mountedChatViews'
import { publishRemoteChat } from '../panels/agentChat/remoteChatRegistry'
import type { ChatBinding } from '../panels/agentChat/chatBinding'
import type { ConversationTransport } from '../panels/agentChat/conversationTransport'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { DiffChatSelection } from './diffToChat'
import type { DiffSourceReading, DiffViewerSource } from './diffViewerSource'
import { DiffViewer } from './DiffViewer'

// The Diff tab on a chat's changes on a paired machine: the same viewer, its
// steps, files and both sides of a file read from that machine, live as the
// machine says the checkout moved, and lines quoted into that chat.

// Monaco needs a canvas; the diff it would draw is its two texts.
vi.mock('@monaco-editor/react', () => ({
  DiffEditor: (props: { original: string; modified: string }) => (
    <div data-diff-editor="" data-original={props.original} data-modified={props.modified} />
  ),
}))
// The selection toolbar reads Monaco's selection; what it hands on is what is tested.
const toolbar = vi.hoisted(() => ({
  onSend: null as null | ((selection: DiffChatSelection, note: string) => Promise<boolean>),
}))
vi.mock('./DiffChatToolbar', () => ({
  DiffChatToolbar: (props: { onSend: (selection: DiffChatSelection, note: string) => Promise<boolean> }) => {
    toolbar.onSend = props.onSend
    return null
  },
}))

const WS = 'ws-paired'
const CHAT = 'far-chat'
const hash = 'c'.repeat(40)

function fakeSource() {
  let tell: ((reading: DiffSourceReading) => void) | null = null
  const texts: Record<string, ConversationChangedFileSides> = {
    'src/calendar.ts': {
      original: { kind: 'content', content: 'export const days = 7\n' },
      modified: { kind: 'content', content: 'export const days = 7\nexport const weeks = 52\n' },
    },
    'notes.md': { original: { kind: 'absent' }, modified: { kind: 'content', content: 'first\n' } },
  }
  const reads: string[] = []
  const source: DiffViewerSource = {
    root: 'paired:connection-1/far-workspace/far-chat',
    machineName: 'mac-mini',
    chatAgentId: CHAT,
    watch(listener) {
      tell = listener
      return () => {
        tell = null
      }
    },
    async stepDiff(selection: BranchStepSelection): Promise<BranchStepDiff> {
      reads.push(`diff:${selection.kind}`)
      return {
        files: [
          { path: 'src/calendar.ts', status: 'modified', additions: 1, deletions: 0 },
          { path: 'notes.md', status: 'new', additions: 1, deletions: 0 },
        ],
        additions: 2,
        deletions: 0,
      }
    },
    async file(selection, path) {
      reads.push(`file:${selection.kind}:${path}`)
      return texts[path]!
    },
  }
  return {
    source,
    reads,
    texts,
    say: (reading: DiffSourceReading) => act(() => tell?.(reading)),
    watching: () => tell !== null,
  }
}

const ready = (revision: string): DiffSourceReading => ({
  state: 'ready',
  revision,
  snapshot: {
    branch: 'feature/calendar',
    baseOid: 'b'.repeat(40),
    scope: 'worktree',
    steps: [{ hash, shortHash: 'ccccccc', subject: 'Count the weeks', authoredAt: 1_000, isMerge: false }],
    hasUncommitted: true,
  },
})

let root: Root | null = null
let host: HTMLElement

async function render(source: DiffViewerSource) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root!.render(
      <DiffViewer
        repoRoot={source.root}
        source={source}
        focusPath={null}
        focusKind={null}
        workspaceId={WS}
        variant="pane"
        branchSteps
      />,
    ),
  )
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
const editor = () => host.querySelector<HTMLElement>('[data-diff-editor]')

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // Nothing of this computer's git is there to be asked.
  Object.assign(window, { api: { platform: 'darwin' } })
  useWorkspaceStore.setState({
    workspaces: [{ id: WS, name: 'demo-app', folderPath: '/Users/dev/demo-app', agents: {} }] as never,
  })
  toolbar.onSend = null
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host.remove()
})

test('reads the steps, the files and each file’s two sides from the machine the chat is on', async () => {
  const far = fakeSource()
  await render(far.source)
  expect(far.watching()).toBe(true)
  expect(host.textContent).toContain('Loading changes')
  far.say(ready('rev-1'))
  await settle()
  expect(host.textContent).toContain('Count the weeks')
  expect(far.reads).toEqual(['diff:span', 'file:span:src/calendar.ts'])
  expect(editor()?.dataset.original).toBe('export const days = 7\n')
  expect(editor()?.dataset.modified).toBe('export const days = 7\nexport const weeks = 52\n')
  expect(host.textContent).toContain('src/calendar.ts')
  // Nothing that opens a folder here is offered for a checkout that is not here.
  expect(host.querySelector('[aria-label="Open in editor"]')).toBeNull()
  expect(host.querySelector('[aria-label="Open in separate window"]')).toBeNull()
  expect(host.querySelector('[aria-label="Tours"]')).toBeNull()
})

test('reads the open file again when the machine says the checkout moved', async () => {
  const far = fakeSource()
  await render(far.source)
  far.say(ready('rev-1'))
  await settle()
  far.texts['src/calendar.ts'] = {
    original: { kind: 'content', content: 'export const days = 7\n' },
    modified: { kind: 'content', content: 'export const days = 7\nexport const weeks = 52\nexport const years = 1\n' },
  }
  far.say(ready('rev-1'))
  await settle()
  expect(editor()?.dataset.modified, 'the same revision reads nothing again').not.toContain('years')
  far.say(ready('rev-2'))
  await settle()
  expect(editor()?.dataset.modified).toContain('export const years = 1')
})

test('says in the machine’s words when it cannot be read, and that a folder is not a repository', async () => {
  const far = fakeSource()
  await render(far.source)
  far.say({
    state: 'error',
    message: 'mac-mini cannot show a chat’s changes here yet. Update SprintEngine Studio there.',
  })
  await settle()
  expect(host.textContent).toContain('Update SprintEngine Studio there')
  far.say({ state: 'not-git' })
  await settle()
  expect(host.textContent).toContain('Not a Git repository')
})

test('quotes selected lines into the chat whose changes they are, a chat on a paired machine', async () => {
  const take = publishRemoteChat(WS, {
    agentId: CHAT,
    key: { connectionId: 'connection-1', workspaceId: 'far-workspace', agentId: CHAT },
    machineName: 'mac-mini',
    hostChanges: true,
    transport: {} as ConversationTransport,
    binding: {} as ChatBinding,
    subagents: [],
    subagentTransport: () => ({}) as ConversationTransport,
  })
  const quoted: string[] = []
  const unregister = registerMountedChatView({
    workspaceId: WS,
    agentId: CHAT,
    isFocused: () => false,
    toggleModelPicker: () => undefined,
    insertQuote: (text) => quoted.push(text),
  })
  try {
    const far = fakeSource()
    await render(far.source)
    far.say(ready('rev-1'))
    await settle()
    expect(toolbar.onSend).not.toBeNull()
    let accepted = false
    await act(async () => {
      accepted = await toolbar.onSend!(
        {
          path: 'src/calendar.ts',
          side: 'modified',
          startLine: 2,
          endLine: 2,
          code: 'export const weeks = 52',
          language: 'typescript',
        },
        'Why 52?',
      )
    })
    expect(accepted).toBe(true)
    expect(quoted).toHaveLength(1)
    expect(quoted[0]).toContain('`src/calendar.ts:L2`')
    expect(quoted[0]).toContain('export const weeks = 52')
    expect(quoted[0]).toContain('Why 52?')
  } finally {
    unregister()
    take()
  }
})
