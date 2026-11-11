// @vitest-environment jsdom
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, test } from 'vitest'

import type { LayoutTemplate } from '../../types/workspace'

// The Files tab of a chat on a paired machine (`conversation-checkout-files`):
// the folder the chat works in over there, listed from there. It used to say
// "No folder open" and offer to open a folder of this disk, which would have
// bound a folder here to a chat that runs there.

const FAR: Record<string, Array<{ name: string; kind: 'file' | 'folder'; ignored?: true }>> = {
  '': [
    { name: 'src', kind: 'folder' },
    { name: 'dist', kind: 'folder', ignored: true },
    { name: 'README.md', kind: 'file' },
  ],
  src: [{ name: 'calendar.ts', kind: 'file' }],
}
const asked: string[] = []
let refuse: string | null = null

;(window as unknown as { api: unknown }).api = new Proxy(
  {
    platform: 'darwin',
    readdir: async (path: string) => {
      asked.push(`local:${path}`)
      return []
    },
    watchPath: async () => async () => {},
    checkIgnored: async () => [],
    workspaceSyncDispatch: async () => ({ ok: true }),
    onMeshConversationSession: () => () => {},
    meshConversationWatchCheckoutFiles: async () => ({ ok: true }),
    meshConversationCheckoutFolder: async (input: { path: string }) => {
      asked.push(`far:${input.path}`)
      if (refuse) return { ok: false, code: 'unsupported', message: refuse }
      return {
        ok: true,
        root: { name: 'app', path: '/Users/dev/app' },
        entries: FAR[input.path] ?? [],
        truncated: false,
      }
    },
  } as Record<string, unknown>,
  {
    get(target, key) {
      if (typeof key !== 'string') return undefined
      if (key in target) return target[key]
      return key.startsWith('on') ? () => () => {} : async () => undefined
    },
  },
)

const { default: FileExplorer } = await import('./FileExplorer')
const { ConfirmDialogProvider } = await import('../ui/ConfirmDialog')
const { useWorkspaceStore } = await import('../../store/workspaceStore')

const template: LayoutTemplate = {
  id: 'files-test',
  name: 'Files',
  description: 'Paired files test template',
  previewSlots: [],
  layout: {
    global: {},
    borders: [],
    layout: { type: 'row', children: [{ type: 'tabset', weight: 100, children: [] }] },
  },
}

let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  asked.length = 0
  refuse = null
})

async function settle(ms = 60): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

async function mount(sessionId: string | undefined): Promise<void> {
  const workspaceId = useWorkspaceStore.getState().addWorkspace(template, {
    name: 'Calendar',
    folderPath: null,
    remoteOrigin: {
      connectionId: 'connection-1',
      machineName: 'mac-mini',
      workspaceId: 'far-workspace',
      workspaceName: 'app',
      workspaceRoot: '/Users/dev/app',
      ...(sessionId ? { sessionId } : {}),
    },
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <ConfirmDialogProvider>
        <FileExplorer workspaceId={workspaceId} />
      </ConfirmDialogProvider>,
    ),
  )
  await settle()
}

test('a paired chat’s Files tab lists the folder it works in over there, and offers no folder of this disk', async () => {
  await mount('conversation:far-workspace:agent-1')
  const text = host?.textContent ?? ''
  assert.ok(!text.includes('No folder open'), text)
  assert.ok(!text.includes('Open folder'), text)
  const rows = Array.from(document.querySelectorAll('[role="treeitem"]')).map((row) => row.textContent ?? '')
  assert.ok(
    rows.some((row) => row.includes('README.md')),
    rows.join(' | '),
  )
  assert.ok(rows.some((row) => row.includes('src')))
  // The root row is the machine's own name for the folder, and where it is.
  assert.ok(text.includes('app'), text)
  assert.ok(text.includes('/Users/dev/app on mac-mini'), text)
  const ignored = document.querySelector('[data-row-ignored="true"]')
  assert.ok(ignored?.textContent?.includes('dist'), 'what git ignores there is dimmed here')
  assert.deepEqual(
    asked.filter((call) => call.startsWith('local:')),
    [],
    'nothing of this disk is read',
  )
})

test('a machine that cannot show them says so in words', async () => {
  refuse = 'mac-mini cannot show a chat’s files here yet. Update SprintEngine Studio there.'
  await mount('conversation:far-workspace:agent-2')
  await settle(200)
  assert.ok((host?.textContent ?? '').includes('Update SprintEngine Studio there'), host?.textContent ?? '')
})

test('a row from before the chat was named says why it cannot read the folder', async () => {
  await mount(undefined)
  const text = host?.textContent ?? ''
  assert.ok(text.includes('Files are on the other machine'), text)
  assert.ok(!text.includes('Open folder'), text)
})
