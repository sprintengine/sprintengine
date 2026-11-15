// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { ContainerSummary } from '../../../../shared/containers'
import { ContainersSection } from './ContainersSection'

let root: Root
let host: HTMLDivElement
const calls: Array<[string, unknown]> = []
let listed: ContainerSummary[] = []
let tokenSet = false

const api = {
  containersList: async () => listed,
  containerRemove: async (target: unknown) => (calls.push(['remove', target]), { ok: true as const }),
  containerPush: async (id: string) => (calls.push(['push', id]), { ok: true as const, message: 'Pushed.' }),
  onContainersChanged: () => () => undefined,
  containerTokenStatus: async () => ({ set: tokenSet, kept: tokenSet ? ('sealed' as const) : null }),
  containerTokenSet: async (token: string) => {
    calls.push(['token-set', token.length])
    if (!token.startsWith('sk-ant-')) return { ok: false as const, message: 'That does not look like a token.' }
    tokenSet = true
    return { ok: true as const }
  },
  containerTokenClear: async () => ((tokenSet = false), calls.push(['token-clear', null]), { ok: true as const }),
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve())
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls.length = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

test('every container Studio made is listed: one with no record too, removable by its host and name', async () => {
  listed = [
    {
      id: '0123456789abcdef',
      name: 'sprintengine-0123456789abcdef',
      host: { kind: 'local' },
      hostLabel: 'this Mac',
      status: 'Up 3 minutes',
      repo: {
        source: '/Users/dev/app',
        path: '/home/node/work/app',
        branch: 'studio/container-01234567',
        base: 'main',
      },
    },
    {
      id: null,
      name: 'sprintengine-fedcba9876543210',
      host: { kind: 'ssh', machine: 'm1' },
      hostLabel: 'build-box',
      status: 'Exited (0) 2 hours ago',
      repo: null,
    },
  ]
  act(() => root.render(<ContainersSection api={api as never} />))
  await flush()
  const text = host.textContent ?? ''
  expect(text).toContain('Containers')
  expect(text).toContain('studio/container-01234567')
  expect(text).toContain('Studio has no record of this one')
  const labels = [...host.querySelectorAll('ul[aria-label="Containers"] button')].map((each) =>
    each.getAttribute('aria-label'),
  )
  expect(labels).toEqual([
    'Push studio/container-01234567 from sprintengine-0123456789abcdef',
    'Remove sprintengine-0123456789abcdef',
    'Remove sprintengine-fedcba9876543210',
  ])
  const rows = host.querySelectorAll<HTMLButtonElement>('ul[aria-label="Containers"] button')
  await act(async () => rows[0]!.click())
  await flush()
  await act(async () => rows[2]!.click())
  await flush()
  expect(calls).toEqual([
    ['push', '0123456789abcdef'],
    ['remove', { host: { kind: 'ssh', machine: 'm1' }, name: 'sprintengine-fedcba9876543210', context: null }],
  ])
})

test("Claude Code's token for containers: pasted once, kept, never shown back, and forgotten", async () => {
  listed = []
  tokenSet = false
  act(() => root.render(<ContainersSection api={api as never} />))
  await flush()
  expect(host.textContent).toContain('Run claude setup-token in a terminal here and paste the token it prints.')
  expect(host.querySelector('ul[aria-label="Containers"]')).toBeNull()
  const field = host.querySelector<HTMLInputElement>('input[aria-label="Claude Code token for containers"]')!
  expect(field.type).toBe('password')
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(field, 'sk-ant-oat01-' + 'x'.repeat(40))
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const save = [...host.querySelectorAll('button')].find((each) => each.textContent === 'Save')!
  await act(async () => save.click())
  await flush()
  expect(calls).toContainEqual(['token-set', 53])
  expect(host.textContent).toContain('sign Claude Code in with your token')
  expect(host.textContent).not.toContain('xxxxxxxx')
  const forget = [...host.querySelectorAll('button')].find((each) => each.textContent === 'Forget token')!
  await act(async () => forget.click())
  await flush()
  expect(calls).toContainEqual(['token-clear', null])
})

test("a deleted chat's container still waiting to be removed says so, and why", async () => {
  tokenSet = false
  listed = [
    {
      id: '0123456789abcdef',
      name: 'sprintengine-0123456789abcdef',
      host: { kind: 'local' },
      hostLabel: 'this Mac',
      status: 'Exited (0) 2 hours ago',
      repo: null,
      pendingRemoval: 'Docker is not running on this Mac, so it is still there.',
    },
  ]
  act(() => root.render(<ContainersSection api={api as never} />))
  await flush()
  expect(host.textContent).toContain(
    'Its chat was deleted; removing it is waiting. Docker is not running on this Mac, so it is still there.',
  )
})

test('a list that could not be read is said in words, never shown as no containers', async () => {
  tokenSet = false
  const failing = { ...api, containersList: async () => Promise.reject(new Error('Studio did not answer in time.')) }
  act(() => root.render(<ContainersSection api={failing as never} />))
  await flush()
  expect(host.textContent).toContain('The containers could not be listed.')
  expect(host.textContent).toContain('Studio did not answer in time.')
  expect(host.querySelector('ul[aria-label="Containers"]')).toBeNull()
})

test('a push, a removal or a token change that gets no answer says so in words', async () => {
  const { useToastStore } = await import('../../store/toastStore')
  useToastStore.setState({ toasts: [] })
  tokenSet = false
  listed = [
    {
      id: '0123456789abcdef',
      name: 'sprintengine-0123456789abcdef',
      host: { kind: 'local' },
      hostLabel: 'this Mac',
      status: 'Up 3 minutes',
      repo: {
        source: '/Users/dev/app',
        path: '/home/node/work/app',
        branch: 'studio/container-01234567',
        base: 'main',
      },
    },
  ]
  const lost = new Error('The connection to Studio closed.')
  const failing = {
    ...api,
    containerPush: async () => Promise.reject(lost),
    containerTokenSet: async () => Promise.reject(lost),
  }
  act(() => root.render(<ContainersSection api={failing as never} />))
  await flush()
  const push = host.querySelector<HTMLButtonElement>('ul[aria-label="Containers"] button')!
  await act(async () => push.click())
  await flush()
  const toast = useToastStore.getState().toasts.find((each) => each.title === 'Not confirmed')
  expect(toast?.description).toContain('The connection to Studio closed.')
  // The buttons work again: nothing is left busy.
  expect(push.disabled).toBe(false)
  const field = host.querySelector<HTMLInputElement>('input[aria-label="Claude Code token for containers"]')!
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(field, 'sk-ant-oat01-x')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const save = [...host.querySelectorAll('button')].find((each) => each.textContent === 'Save')!
  await act(async () => save.click())
  await flush()
  expect(host.textContent).toContain('The token was not saved. The connection to Studio closed.')
})

test('a container made before the server and the agent were separate users says they share one', async () => {
  tokenSet = false
  const row = (id: string, oneUser: boolean): ContainerSummary => ({
    id,
    name: `sprintengine-${id}`,
    host: { kind: 'local' },
    hostLabel: 'this Mac',
    status: 'Up 3 minutes',
    repo: null,
    ...(oneUser ? { oneUser: true } : {}),
  })
  listed = [row('0123456789abcdef', true), row('fedcba9876543210', false)]
  act(() => root.render(<ContainersSection api={api as never} />))
  await flush()
  const rows = [...host.querySelectorAll('li')].map((each) => each.textContent ?? '')
  expect(rows.find((text) => text.includes('sprintengine-0123456789abcdef'))).toContain(
    'Made before Studio ran its server and the agent as separate users',
  )
  expect(rows.find((text) => text.includes('sprintengine-fedcba9876543210'))).not.toContain('separate users')
})
