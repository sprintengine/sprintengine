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

const api = {
  containersList: async () => listed,
  containerRemove: async (target: unknown) => (calls.push(['remove', target]), { ok: true as const }),
  containerPush: async (id: string) => (calls.push(['push', id]), { ok: true as const, message: 'Pushed.' }),
  onContainersChanged: () => () => undefined,
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
  const labels = [...host.querySelectorAll('button')].map((each) => each.getAttribute('aria-label'))
  expect(labels).toEqual([
    'Push studio/container-01234567 from sprintengine-0123456789abcdef',
    'Remove sprintengine-0123456789abcdef',
    'Remove sprintengine-fedcba9876543210',
  ])
  await act(async () => (host.querySelectorAll('button')[0] as HTMLButtonElement).click())
  await flush()
  await act(async () => (host.querySelectorAll('button')[2] as HTMLButtonElement).click())
  await flush()
  expect(calls).toEqual([
    ['push', '0123456789abcdef'],
    ['remove', { host: { kind: 'ssh', machine: 'm1' }, name: 'sprintengine-fedcba9876543210' }],
  ])
})

test('no section while Studio has made no container', async () => {
  listed = []
  act(() => root.render(<ContainersSection api={api as never} />))
  await flush()
  expect(host.textContent).toBe('')
})
