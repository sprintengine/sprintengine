// @vitest-environment jsdom
import { fakePairedStudios } from '../studio/environmentStudio.double'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { ConfirmDialogProvider } from '../components/ui/ConfirmDialog'
import type { RemoteSessionOpenSpec } from '../components/workspace/remoteBand/remoteSessionsModel'
import { useToastStore } from '../store/toastStore'
import { useDeleteSettledChats, type SettledChatToDelete } from './useDeleteSettledChats'

// Another environment's settled chat is deleted there, as that environment
// plans it and after the person confirms what goes, for every device that
// follows it; nothing of it is kept here to delete. This computer's own are
// deleted by its own Studio. One confirmation covers them all, and an
// environment that refuses leaves its chat as it is.

let host: HTMLElement | null = null
const calls: Array<[string, unknown]> = []
const deletedThere: string[] = []

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls.length = 0
  useToastStore.setState({ toasts: [] })
  deletedThere.length = 0
})

afterEach(() => {
  host?.remove()
  host = null
})

function spec(route: string, machineName: string, chatId: string): RemoteSessionOpenSpec {
  return {
    route,
    machineName,
    connectionId: route.startsWith('tailnet:') ? route.slice('tailnet:'.length) : null,
    chatId,
    agent: null,
    title: chatId,
    workspaceName: chatId,
    workspaceRoot: null,
    repository: null,
    attachedWorkspaceId: null,
  }
}

const PAIRED: SettledChatToDelete = {
  key: 'env-mini:rw4',
  chatId: 'rw4',
  title: 'Parser review',
  environment: spec('tailnet:c1', 'mac-mini', 'rw4'),
}
const SSH: SettledChatToDelete = {
  key: 'env-box:w-box',
  chatId: 'w-box',
  title: 'Fix the build',
  environment: spec('ssh:box-1', 'build-box', 'w-box'),
}
const LOCAL: SettledChatToDelete = { key: 'w-here', chatId: 'w-here', title: 'Notes', environment: null }

/** This window's Studio, and each environment's as the window reaches it (a paired one by its pairing), planning as `plans` says. */
function api(plans: Record<string, Record<string, unknown>>) {
  const windowApi = {
    planSettledChatDeletion: async (ids: string[]) => {
      calls.push(['plan here', ids])
      return ids.map((workspaceId) => ({ workspaceId, remoteMachine: null, worktrees: [] }))
    },
    deleteSettledChats: async (ids: string[]) => {
      calls.push(['delete here', ids])
      return ids.map((workspaceId) => ({ workspaceId, ok: true, worktrees: [] }))
    },
  }
  ;(window as unknown as { api: unknown }).api = windowApi
  fakePairedStudios(windowApi, {
    'conversation.deletePlan': (params, route) => {
      calls.push(['plan there', { route, workspaceId: params.workspaceId }])
      return plans[route] ?? { worktrees: [] }
    },
    'conversation.delete': (params, route) => {
      calls.push(['delete there', { route, workspaceId: params.workspaceId, commanded: !!params.commandId }])
      return { worktrees: [] }
    },
  })
}

async function mount() {
  let deleteChats: ((chats: readonly SettledChatToDelete[]) => Promise<string[]>) | null = null
  function Probe() {
    deleteChats = useDeleteSettledChats({ onDeletedThere: (route) => deletedThere.push(route) }).deleteChats
    return null
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () =>
    root.render(
      <ConfirmDialogProvider>
        <Probe />
      </ConfirmDialogProvider>,
    ),
  )
  return { run: (chats: readonly SettledChatToDelete[]) => deleteChats!(chats), root }
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
const confirmButton = () =>
  [...document.body.querySelectorAll('button')].find((button) => (button.textContent ?? '').startsWith('Delete'))

test('a paired machine’s settled chat is deleted there after the person confirms, and nothing here', async () => {
  api({
    c1: {
      worktrees: [
        {
          name: 'chat-k_iq',
          branch: 'agent/chat-k_iq',
          pooled: false,
          changedPaths: 0,
          unpushedCommits: 2,
          fate: 'remove',
        },
      ],
    },
  })
  const { run, root } = await mount()
  let done: Promise<string[]> | null = null
  await act(async () => {
    done = run([PAIRED])
  })
  await settle()
  const dialog = document.body.querySelector('[role="dialog"], [role="alertdialog"]')
  expect(dialog?.textContent).toContain('Delete “Parser review”?')
  expect(dialog?.textContent).toContain('It runs on mac-mini, and is deleted there, for every device that follows it.')
  expect(dialog?.textContent).toContain('chat-k_iq')
  await act(async () => confirmButton()!.click())
  expect(await done!).toEqual(['env-mini:rw4'])
  expect(calls).toEqual([
    ['plan there', { route: 'c1', workspaceId: 'rw4' }],
    ['delete there', { route: 'c1', workspaceId: 'rw4', commanded: true }],
  ])
  expect(deletedThere).toEqual(['tailnet:c1'])
  await act(async () => root.unmount())
})

test('a chat its machine will not delete now is said so, and nothing goes', async () => {
  api({ c1: { worktrees: [], refused: 'An agent in this chat is still working.' } })
  const { run, root } = await mount()
  let gone: string[] = ['x']
  await act(async () => {
    gone = await run([PAIRED])
  })
  expect(gone).toEqual([])
  expect(calls.map(([kind]) => kind)).toEqual(['plan there'])
  expect(useToastStore.getState().toasts.at(-1)?.description).toBe('An agent in this chat is still working.')
  await act(async () => root.unmount())
})

test('two environments and this computer: one confirmation, each deleted where it is, the one that refuses left', async () => {
  api({ 'ssh:box-1': { worktrees: [], refused: 'An agent in this chat is still working.' } })
  const { run, root } = await mount()
  let done: Promise<string[]> | null = null
  await act(async () => {
    done = run([SSH, PAIRED, LOCAL])
  })
  await settle()
  const dialog = document.body.querySelector('[role="dialog"], [role="alertdialog"]')
  expect(dialog?.textContent).toContain('1 other chat can')
  expect(dialog?.textContent).toContain('Chats on another machine are deleted there')
  await act(async () => confirmButton()!.click())
  const deleted = await done!
  expect([...deleted].sort()).toEqual(['env-mini:rw4', 'w-here'])
  expect(calls).toEqual(
    expect.arrayContaining([
      ['plan here', ['w-here']],
      ['plan there', { route: 'ssh:box-1', workspaceId: 'w-box' }],
      ['plan there', { route: 'c1', workspaceId: 'rw4' }],
      ['delete here', ['w-here']],
      ['delete there', { route: 'c1', workspaceId: 'rw4', commanded: true }],
    ]),
  )
  expect(calls).toHaveLength(5)
  expect(deletedThere).toEqual(['tailnet:c1'])
  await act(async () => root.unmount())
})
