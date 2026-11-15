// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { ContainerUnpushed } from '../../../../shared/containers'
import type { SshEnvironmentSummary } from '../../../../shared/ssh-environments'
import { ConfirmDialogProvider } from '../ui'
import { ContainerMachineDetail, type ContainerApi } from './ContainerMachinesSection'

let root: Root
let host: HTMLDivElement
const calls: Array<[string, unknown]> = []
const nothing = { branches: [], dirty: [], detached: [], stashes: [], chatsRunning: 0 }
let unpushed: ContainerUnpushed = { ok: true, ...nothing }
let forgetAnswers: Array<{ ok: true } | { ok: false; message: string; containers?: string[] }> = []

const api = {
  containerDockerStatus: async () => ({ state: 'ready', words: '', imageReady: true, canStart: null }),
  containerStartDocker: async () => ({ state: 'ready', words: '', imageReady: true, canStart: null }),
  containerCreate: async () => ({ ok: false, message: 'not here' }),
  containerClone: async (id: string, address: string) => (
    calls.push(['clone', [id, address]]),
    { ok: true as const, folder: '/home/node/work/app' }
  ),
  containerUnpushed: async (id: string) => (calls.push(['unpushed', id]), unpushed),
  sshEnvironmentForget: async (id: string, options?: Record<string, unknown>) => (
    calls.push(['forget', options && Object.keys(options).length ? [id, options] : id]),
    forgetAnswers.shift() ?? { ok: true as const }
  ),
  sshEnvironmentDiagnostics: async () => ({ ok: true as const, text: '' }),
} as unknown as ContainerApi

const sandbox: SshEnvironmentSummary = {
  id: '0123456789abcdef',
  label: 'sandbox',
  destination: 'sprintengine-0123456789abcdef',
  resolved: null,
  environmentId: null,
  settings: { keepRunning: true, paneTraffic: 'all', installDir: null, remoteDownload: false },
  addedAt: 0,
  container: {
    host: { kind: 'ssh', machine: 'aaaaaaaaaaaaaaaa' },
    name: 'sprintengine-0123456789abcdef',
    image: 'sprintengine-studio-agent:0123456789ab',
    createdAt: 0,
  },
  state: 'connected',
  stateText: 'Connected',
  working: false,
  action: null,
  server: null,
  notes: [],
}
const buildBox = {
  ...sandbox,
  id: 'aaaaaaaaaaaaaaaa',
  label: 'build-box',
  destination: 'build-box',
  container: undefined,
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => await Promise.resolve())
}
const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((each) => each.textContent === text)

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls.length = 0
  forgetAnswers = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function renderDetail() {
  await act(async () =>
    root.render(
      <ConfirmDialogProvider>
        <ContainerMachineDetail machine={sandbox} machines={[buildBox, sandbox]} api={api} />
      </ConfirmDialogProvider>,
    ),
  )
}

test("a container's detail says where it runs and its Docker name, and clones into it", async () => {
  await renderDetail()
  expect(host.textContent).toContain('build-box')
  expect(host.textContent).toContain('sprintengine-0123456789abcdef')
  const field = host.querySelector<HTMLInputElement>('input')!
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(field, 'acme/app')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => button('Clone')!.click())
  await flush()
  expect(calls).toEqual([['clone', ['0123456789abcdef', 'acme/app']]])
  expect(host.textContent).toContain('Cloned into /home/node/work/app.')
})

test('Delete container first lists what exists only in it, and deletes only when told', async () => {
  unpushed = {
    ok: true,
    branches: [{ repo: '/home/node/work/app', branch: 'agent/fix', commits: 2 }],
    dirty: [{ worktree: '/home/node/work/.sprintengine-worktrees/app/one', files: 3 }],
    detached: [{ worktree: '/home/node/work/.sprintengine-worktrees/app/two', commits: 1 }],
    stashes: [{ repo: '/home/node/work/app', count: 1 }],
    chatsRunning: 1,
  }
  await renderDetail()
  await act(async () => button('Delete container')!.click())
  await flush()
  const items = [...document.querySelectorAll('[data-unpushed-work="true"] li')].map((each) => each.textContent)
  expect(items).toEqual([
    'agent/fix in ~/work/app: 2 commits on no remote',
    '~/work/.sprintengine-worktrees/app/one: 3 files changed and not committed',
    '~/work/.sprintengine-worktrees/app/two: 1 commit on a detached HEAD, on no branch or remote',
    '~/work/app: 1 stash',
  ])
  expect(document.body.textContent).toContain('1 chat is running in it now, and stop with it.')
  expect(calls).toEqual([['unpushed', '0123456789abcdef']])
  // The dialog's own Delete container confirms; the row's button is the first match.
  const confirmButtons = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
    (each) => each.textContent === 'Delete container',
  )
  await act(async () => confirmButtons[confirmButtons.length - 1]!.click())
  await flush()
  expect(calls).toEqual([
    ['unpushed', '0123456789abcdef'],
    ['forget', '0123456789abcdef'],
  ])
})

test('a container Studio could not look inside says so before it is deleted', async () => {
  unpushed = { ok: false, message: 'Docker is not running on build-box.' }
  await renderDetail()
  await act(async () => button('Delete container')!.click())
  await flush()
  expect(document.body.textContent).toContain(
    'Studio could not look inside it for work that exists only there: Docker is not running on build-box.',
  )
  await act(async () => button('Cancel')?.click())
  await flush()
  expect(calls.map(([call]) => call)).toEqual(['unpushed'])
})

test('nothing found is said as what was looked at, not as everything pushed', async () => {
  unpushed = { ok: true, ...nothing, chatsRunning: null }
  await renderDetail()
  await act(async () => button('Delete container')!.click())
  await flush()
  expect(document.body.textContent).toContain('Studio found no commit on no remote, no uncommitted change and no stash')
  expect(document.body.textContent).toContain('Studio could not ask its server whether a chat is running in it.')
  expect(document.body.textContent).not.toContain('Every branch')
})

test('a container Docker cannot remove may have only its record forgotten', async () => {
  unpushed = { ok: true, ...nothing }
  forgetAnswers = [
    { ok: false, message: 'Docker is not running on build-box, so sprintengine-0123456789abcdef is still there.' },
  ]
  await renderDetail()
  await act(async () => button('Delete container')!.click())
  await flush()
  const confirmAll = () => [...document.querySelectorAll<HTMLButtonElement>('button')]
  await act(async () =>
    confirmAll()
      .filter((each) => each.textContent === 'Delete container')
      .pop()!
      .click(),
  )
  await flush()
  expect(document.body.textContent).toContain("Forget only sandbox's record?")
  await act(async () => button('Forget its record')!.click())
  await flush()
  expect(calls).toEqual([
    ['unpushed', '0123456789abcdef'],
    ['forget', '0123456789abcdef'],
    ['forget', ['0123456789abcdef', { recordOnly: true }]],
  ])
})

test("an SSH machine's containers are each deleted the same way before it is forgotten", async () => {
  unpushed = { ok: true, ...nothing, branches: [{ repo: '/home/node/work/app', branch: 'agent/fix', commits: 1 }] }
  forgetAnswers = [
    { ok: false, message: 'build-box has a container Studio made (sandbox).', containers: ['0123456789abcdef'] },
  ]
  const { SshMachineDetail } = await import('./SshMachinesSection')
  await act(async () =>
    root.render(
      <ConfirmDialogProvider>
        <SshMachineDetail
          machine={{ ...buildBox, settings: sandbox.settings }}
          machines={[buildBox, sandbox]}
          api={{ ...api, sshEnvironmentDiagnostics: async () => ({ ok: true as const, text: '' }) } as never}
        />
      </ConfirmDialogProvider>,
    ),
  )
  await act(async () => button('Forget')!.click())
  await flush()
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('button')]
      .filter((each) => each.textContent === 'Forget')
      .pop()!
      .click(),
  )
  await flush()
  await act(async () => button('Delete them, then forget')!.click())
  await flush()
  // The container's own warning, with what exists only in it.
  expect(document.querySelector('[data-unpushed-work="true"]')?.textContent).toBe(
    'agent/fix in ~/work/app: 1 commit on no remote',
  )
  await act(async () => button('Delete container')!.click())
  await flush()
  expect(calls).toEqual([
    ['forget', 'aaaaaaaaaaaaaaaa'],
    ['unpushed', '0123456789abcdef'],
    ['forget', '0123456789abcdef'],
    ['forget', 'aaaaaaaaaaaaaaaa'],
  ])
})
