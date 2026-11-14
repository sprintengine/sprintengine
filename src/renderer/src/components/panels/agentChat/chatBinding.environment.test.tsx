// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { LayoutTemplate } from '../../../types/workspace'

// What a chat on an SSH machine holds there (its scheduled and held
// messages) is that machine's to say. Once the machine is forgotten in
// Settings › Machines, this window can neither follow nor change it, so the
// chat stops showing what the machine last said it held.

const local = {
  environmentId: 'env-local',
  displayName: 'This Mac',
  routes: [{ kind: 'local' }],
  machine: { kind: 'local' },
  descriptor: null,
  connection: { state: 'up', detail: null, lastReachedAt: null },
  compatibility: 'compatible',
}
const machine = {
  ...local,
  environmentId: 'env-box',
  displayName: 'dev@build-box',
  routes: [{ kind: 'ssh', machine: 'm1' }],
}
let listed: unknown[] = [local, machine]
const changed = new Set<() => void>()

;(window as unknown as { api: unknown }).api = new Proxy(
  {
    platform: 'darwin',
    workspaceSyncDispatch: async () => ({ ok: true }),
    environmentsList: async () => listed,
    onEnvironmentsChanged: (listener: () => void) => {
      changed.add(listener)
      return () => changed.delete(listener)
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

const { useWorkspaceStore } = await import('../../../store/workspaceStore')
const { useLocalChatBinding } = await import('./chatBinding')
const { ConversationTransportProvider, useConversationTransport } = await import('./conversationTransport')
const { resetEnvironmentsForTests } = await import('../../../hooks/useEnvironments')

const template: LayoutTemplate = {
  id: 'binding-test',
  name: 'Binding',
  description: 'Chat binding test template',
  previewSlots: [],
  layout: {
    global: {},
    borders: [],
    layout: { type: 'row', children: [{ type: 'tabset', weight: 100, children: [] }] },
  },
}

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
  resetEnvironmentsForTests()
})

test("a forgotten machine's scheduled messages are no longer shown in its chat", async () => {
  const workspaceId = useWorkspaceStore.getState().addWorkspace(template, {
    name: 'Proj',
    folderPath: 'ssh://m1/home/dev/proj',
  })
  useWorkspaceStore.setState((state) => ({
    workspaces: state.workspaces.map((workspace) =>
      workspace.id === workspaceId
        ? {
            ...workspace,
            environment: { kind: 'ssh', id: 'm1', label: 'dev@build-box' },
            agents: { 'agent-1': { name: 'Chat', conversation: { providerId: 'fake' } } as never },
          }
        : workspace,
    ),
  }))
  // The machine's push of what it keeps for the chat: one message at 3 PM.
  const following = new Set<string>()
  const followPush = ((input: { topic: string; onPayload: (payload: unknown) => void }) => {
    following.add(input.topic)
    if (input.topic === 'conversation.scheduled')
      input.onPayload({ messages: [{ id: 'm-1', text: 'Run the tests', sendAt: 1 }] })
    return () => following.delete(input.topic)
  }) as never
  const seen: Array<number | undefined> = []
  function Probe() {
    const binding = useLocalChatBinding(workspaceId, 'agent-1')
    seen.push(binding?.hostSchedule?.messages.length)
    return null
  }
  function OnMachine({ children }: { children: React.ReactNode }) {
    const window = useConversationTransport()
    return (
      <ConversationTransportProvider
        value={{
          ...window,
          environment: { id: null, label: 'dev@build-box', route: 'ssh:m1' },
          services: { ...window.services, followPush },
        }}
      >
        {children}
      </ConversationTransportProvider>
    )
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <OnMachine>
        <Probe />
      </OnMachine>,
    ),
  )
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
  expect(seen.at(-1), 'shown while the machine is saved').toBe(1)
  expect(following.has('conversation.scheduled')).toBe(true)

  // Forget the machine.
  listed = [local]
  await act(async () => {
    for (const listener of [...changed]) listener()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  expect(seen.at(-1), 'gone once it is forgotten').toBe(0)
  expect(following.has('conversation.scheduled'), 'and no longer followed').toBe(false)
})
