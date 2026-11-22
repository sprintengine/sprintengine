// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { chatWelcome } from '../../../../../../../tests/chat-welcome'
import { fakeMonaco } from '../../../../../../../tests/fake-monaco-editor'
import { ConversationLinkProvider } from '../conversationLinks'
import {
  ConversationTransportProvider,
  studioConversationTransport,
  type ChatFileViewWrite,
  type ConversationTransport,
} from '../conversationTransport'
import type { TranscriptToolEntry } from '../conversationProjection'
import { FileViewCard } from './FileViewCard'
import { FILE_VIEW_SAVE_PAUSE_MS, fileViewFiles, fileViewHeightLines, fileViewTabLabels } from './fileViewModel'

vi.mock('@monaco-editor/react', () => import('../../../../../../../tests/fake-monaco-editor'))

// The files an agent showed with `file.view`: an editor of each, in tabs,
// saved through the chat's own Studio after a pause or on Cmd/Ctrl+S, never
// over a file that changed on disk since it was read.

const CLAUDE = '/Users/dev/.claude/CLAUDE.md'
const APP = '/Users/dev/app/src/app.ts'

function toolShowing(files: Array<{ path: string; name: string; highlights?: unknown[] }>): TranscriptToolEntry {
  return {
    kind: 'tool',
    id: 'tool-1',
    turnId: 'turn-1',
    name: 'mcp__sprintengine-studio__file_view',
    status: 'done',
    outputStatus: 'success' as TranscriptToolEntry['outputStatus'],
    output: JSON.stringify({ ok: true, files: files.map((file) => ({ lines: 3, highlights: [], ...file })) }),
  }
}

type Disk = Map<string, { text: string; hash: string }>

function fakeTransport(disk: Disk, writes: Array<{ path: string; text: string; ifMatch: string }>, operate = true) {
  const base = studioConversationTransport(() => chatWelcome())
  let version = 0
  const transport: ConversationTransport = {
    ...base,
    capabilities: { ...base.capabilities, operate },
    readFileView: async ({ path }) => {
      const file = disk.get(path)
      return file ? { ok: true, text: file.text, hash: file.hash, mtimeMs: 1 } : { ok: false, message: 'gone' }
    },
    writeFileView: async ({ path, text, ifMatch }): Promise<ChatFileViewWrite> => {
      writes.push({ path, text, ifMatch })
      const file = disk.get(path)
      if (!file || file.hash !== ifMatch) return { ok: false, conflict: true, currentHash: file?.hash ?? null }
      const hash = `h${(version += 1)}`
      disk.set(path, { text, hash })
      return { ok: true, hash, mtimeMs: 2 }
    },
  }
  return transport
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  // As the app's Monaco sets it when the window boots (utils/monacoRuntime.ts).
  ;(globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment = {}
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  fakeMonaco.editors.length = 0
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

async function render(tool: TranscriptToolEntry, transport: ConversationTransport): Promise<void> {
  await act(async () =>
    root.render(
      <ConversationTransportProvider value={transport}>
        <ConversationLinkProvider
          workspaceId="ws"
          agentId="agent-1"
          cwd="/Users/dev/app"
          workspaceRoot="/Users/dev/app"
        >
          <FileViewCard tool={tool} fallback={<div>tool row</div>} />
        </ConversationLinkProvider>
      </ConversationTransportProvider>,
    ),
  )
  await act(async () => {})
}

const statusText = () => container.querySelector('[role="status"]')?.textContent ?? null

test('the file opens under its path, and an edit is saved after a pause in typing', async () => {
  const disk: Disk = new Map([[CLAUDE, { text: '# Rules\n', hash: 'h0' }]])
  const writes: Array<{ path: string; text: string; ifMatch: string }> = []
  await render(toolShowing([{ path: CLAUDE, name: 'CLAUDE.md' }]), fakeTransport(disk, writes))
  expect(container.textContent).toContain(CLAUDE)
  expect(statusText()).toBe('Saved')
  const editor = fakeMonaco.editors.at(-1)!
  expect(editor.text).toBe('# Rules\n')

  await act(async () => editor.type('# Rules\n\nBe brief.\n'))
  expect(statusText()).toBe('Not saved yet')
  expect(writes).toEqual([])
  await act(async () => {
    vi.advanceTimersByTime(FILE_VIEW_SAVE_PAUSE_MS)
  })
  await act(async () => {})
  expect(writes).toEqual([{ path: CLAUDE, text: '# Rules\n\nBe brief.\n', ifMatch: 'h0' }])
  expect(disk.get(CLAUDE)?.text).toBe('# Rules\n\nBe brief.\n')
  expect(statusText()).toBe('Saved')
})

test('Cmd/Ctrl+S saves at once, and the next save is conditional on what that one wrote', async () => {
  const disk: Disk = new Map([[CLAUDE, { text: 'a\n', hash: 'h0' }]])
  const writes: Array<{ path: string; text: string; ifMatch: string }> = []
  await render(toolShowing([{ path: CLAUDE, name: 'CLAUDE.md' }]), fakeTransport(disk, writes))
  const editor = fakeMonaco.editors.at(-1)!
  const saveCommand = editor.commands.find(
    (command) => command.keybinding === (fakeMonaco.CTRL_CMD | fakeMonaco.KEY_S),
  )!
  await act(async () => editor.type('b\n'))
  await act(async () => {
    saveCommand.run()
  })
  await act(async () => {})
  expect(writes).toEqual([{ path: CLAUDE, text: 'b\n', ifMatch: 'h0' }])
  await act(async () => editor.type('c\n'))
  await act(async () => {
    saveCommand.run()
  })
  await act(async () => {})
  expect(writes.at(-1)).toEqual({ path: CLAUDE, text: 'c\n', ifMatch: 'h1' })
})

test('a file changed on disk is not written over: the view says so, and saves over it only when asked', async () => {
  const disk: Disk = new Map([[APP, { text: 'one\n', hash: 'h0' }]])
  const writes: Array<{ path: string; text: string; ifMatch: string }> = []
  await render(toolShowing([{ path: APP, name: 'app.ts' }]), fakeTransport(disk, writes))
  const editor = fakeMonaco.editors.at(-1)!
  disk.set(APP, { text: 'theirs\n', hash: 'other' })
  await act(async () => editor.type('mine\n'))
  await act(async () => {
    vi.advanceTimersByTime(FILE_VIEW_SAVE_PAUSE_MS)
  })
  await act(async () => {})
  expect(disk.get(APP)?.text).toBe('theirs\n')
  expect(container.textContent).toContain('This file changed on disk since you opened it')

  // More typing does not try again on its own.
  await act(async () => editor.type('mine, more\n'))
  await act(async () => {
    vi.advanceTimersByTime(FILE_VIEW_SAVE_PAUSE_MS * 2)
  })
  expect(writes).toHaveLength(1)

  const keepMine = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Save mine over it',
  )!
  await act(async () => keepMine.click())
  await act(async () => {})
  expect(disk.get(APP)?.text).toBe('mine, more\n')
  expect(writes.at(-1)?.ifMatch).toBe('other')
  expect(statusText()).toBe('Saved')
})

test('loading the file again after a conflict shows what is on disk', async () => {
  const disk: Disk = new Map([[APP, { text: 'one\n', hash: 'h0' }]])
  await render(toolShowing([{ path: APP, name: 'app.ts' }]), fakeTransport(disk, []))
  const editor = fakeMonaco.editors.at(-1)!
  disk.set(APP, { text: 'theirs\n', hash: 'other' })
  await act(async () => editor.type('mine\n'))
  await act(async () => {
    vi.advanceTimersByTime(FILE_VIEW_SAVE_PAUSE_MS)
  })
  await act(async () => {})
  const reload = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Load the file from disk',
  )!
  await act(async () => reload.click())
  await act(async () => {})
  expect(fakeMonaco.editors.at(-1)!.text).toBe('theirs\n')
  expect(statusText()).toBe('Saved')
})

test('several files are tabs, each its own file with its own save', async () => {
  const disk: Disk = new Map([
    [CLAUDE, { text: 'rules\n', hash: 'c0' }],
    [APP, { text: 'code\n', hash: 'a0' }],
  ])
  const writes: Array<{ path: string; text: string; ifMatch: string }> = []
  await render(
    toolShowing([
      { path: CLAUDE, name: 'CLAUDE.md' },
      { path: APP, name: 'app.ts' },
    ]),
    fakeTransport(disk, writes),
  )
  const tabs = [...container.querySelectorAll('[role="tab"]')]
  expect(tabs.map((tab) => tab.textContent)).toEqual(['CLAUDE.md', 'app.ts'])
  await act(async () => (tabs[1] as HTMLButtonElement).click())
  expect(container.textContent).toContain(APP)
  await act(async () => fakeMonaco.editors.at(-1)!.type('code, changed\n'))
  await act(async () => {
    vi.advanceTimersByTime(FILE_VIEW_SAVE_PAUSE_MS)
  })
  await act(async () => {})
  expect(writes).toEqual([{ path: APP, text: 'code, changed\n', ifMatch: 'a0' }])
  expect(disk.get(CLAUDE)?.text).toBe('rules\n')
})

test('the lines the agent pointed at are marked, with its note, and the editor opens at the first', async () => {
  const disk: Disk = new Map([[APP, { text: 'a\nb\nc\nd\n', hash: 'h0' }]])
  await render(
    toolShowing([
      {
        path: APP,
        name: 'app.ts',
        highlights: [
          { from: 3, to: 4, note: 'look here' },
          { from: 1, to: 1 },
        ],
      },
    ]),
    fakeTransport(disk, []),
  )
  const editor = fakeMonaco.editors.at(-1)!
  expect(editor.revealed).toEqual([1])
  const [lines, notes] = editor.decorations as Array<
    Array<{ range: { startLineNumber: number }; options: Record<string, unknown> }>
  >
  expect(lines!.map((decoration) => decoration.range.startLineNumber)).toEqual([1, 3])
  expect(lines![0]!.options.className).toBe('file-view-highlight')
  expect(notes!.map((decoration) => (decoration.options.after as { content: string }).content.trim())).toEqual([
    'look here',
  ])
  // After the end of the range's first line, where Monaco draws it.
  expect((notes![0]!.range as unknown as { startColumn: number }).startColumn).toBe(2)
  expect(notes![0]!.options.showIfCollapsed).toBe(true)
})

test('a view that cannot change the chat shows the file read only, and saves nothing', async () => {
  const disk: Disk = new Map([[APP, { text: 'code\n', hash: 'a0' }]])
  const writes: Array<{ path: string; text: string; ifMatch: string }> = []
  await render(toolShowing([{ path: APP, name: 'app.ts' }]), fakeTransport(disk, writes, false))
  expect(statusText()).toBe('Read only')
  const editor = fakeMonaco.editors.at(-1)!
  await act(async () => editor.type('changed\n'))
  await act(async () => editor.commands[0]?.run())
  await act(async () => {
    vi.advanceTimersByTime(FILE_VIEW_SAVE_PAUSE_MS)
  })
  expect(writes).toEqual([])
})

test('a window without the app’s Monaco (an embedded chat) keeps the tool row', async () => {
  delete (globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment
  const disk: Disk = new Map([[APP, { text: 'code\n', hash: 'a0' }]])
  await render(toolShowing([{ path: APP, name: 'app.ts' }]), fakeTransport(disk, []))
  expect(container.textContent).toBe('tool row')
})

test('an answer that names no file stays the tool row', async () => {
  const tool = { ...toolShowing([]), output: 'not json' }
  await render(tool, fakeTransport(new Map(), []))
  expect(container.textContent).toBe('tool row')
})

test('the model: files from the answer, tab labels that tell twins apart, a bounded height', () => {
  expect(
    fileViewFiles({
      outputStatus: 'success' as TranscriptToolEntry['outputStatus'],
      output: JSON.stringify({ files: [{ path: APP, highlights: [{ from: 5, to: 2 }] }, { path: APP }, { nope: 1 }] }),
    }),
  ).toEqual([{ path: APP, name: 'app.ts', highlights: [{ from: 5, to: 5 }] }])
  expect(fileViewFiles({ outputStatus: 'error' as TranscriptToolEntry['outputStatus'], output: '{}' })).toEqual([])
  expect(
    fileViewTabLabels([
      { path: '/Users/dev/a/CLAUDE.md', name: 'CLAUDE.md', highlights: [] },
      { path: '/Users/dev/b/CLAUDE.md', name: 'CLAUDE.md', highlights: [] },
      { path: APP, name: 'app.ts', highlights: [] },
    ]),
  ).toEqual(['a/CLAUDE.md', 'b/CLAUDE.md', 'app.ts'])
  expect(fileViewHeightLines(1)).toBe(3)
  expect(fileViewHeightLines(500)).toBe(18)
})
