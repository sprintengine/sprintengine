// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { DEFAULT_SSH_ENVIRONMENT_SETTINGS, type SshEnvironmentSummary } from '../../../../shared/ssh-environments'
import { ConfirmDialogProvider } from '../ui'
import { AddSshMachine, SshMachineActions } from './SshMachinesSection'

let root: Root
let host: HTMLDivElement
const calls: Array<[string, unknown]> = []
let machines: SshEnvironmentSummary[] = []

const machine = (patch: Partial<SshEnvironmentSummary>): SshEnvironmentSummary => ({
  id: 'e1',
  label: 'build-box',
  destination: 'build-box',
  resolved: { hostname: '192.0.2.10', user: 'dev', port: 22, proxyJump: null },
  environmentId: null,
  settings: { ...DEFAULT_SSH_ENVIRONMENT_SETTINGS },
  addedAt: 0,
  state: 'idle',
  stateText: 'Not connected',
  working: false,
  action: 'connect',
  server: null,
  notes: [],
  ...patch,
})

const api = {
  sshEnvironmentsList: async () => machines,
  sshEnvironmentResolve: async (destination: string) => {
    calls.push(['resolve', destination])
    return {
      ok: true as const,
      destination,
      resolved: { hostname: '192.0.2.10', user: 'dev', port: 2222, proxyJump: 'bastion', notes: [] },
    }
  },
  sshEnvironmentSuggestions: async () => ['build-box', 'mac-mini'],
  sshEnvironmentAdd: async (input: { destination: string }) => (
    calls.push(['add', input]),
    { ok: true as const, id: 'e2' }
  ),
  sshEnvironmentUpdate: async (id: string, patch: unknown) => (
    calls.push(['update', { id, patch }]),
    { ok: true as const }
  ),
  sshEnvironmentConnect: async (id: string) => (calls.push(['connect', id]), { ok: true as const }),
  sshEnvironmentDisconnect: async (id: string) => (calls.push(['disconnect', id]), { ok: true as const }),
  sshEnvironmentStopServer: async () => ({ ok: true as const }),
  sshEnvironmentUpgradeServer: async () => ({ ok: true as const }),
  sshEnvironmentForget: async () => ({ ok: true as const }),
  sshEnvironmentDiagnostics: async () => ({ ok: true as const, text: 'Machine: build-box' }),
  onSshEnvironmentsChanged: () => () => undefined,
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve())
}
const button = (name: string) =>
  [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === name,
  ) as HTMLButtonElement

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

const render = async (node: React.ReactNode) => {
  act(() => root.render(<ConfirmDialogProvider>{node}</ConfirmDialogProvider>))
  await flush()
}

test('an SSH machine’s own row actions: Disconnect while connected, Update for a server it may replace, else none', async () => {
  await render(
    <>
      <SshMachineActions
        api={api as never}
        machine={machine({ id: 'e1', state: 'connected', stateText: 'Connected', action: null })}
      />
      <SshMachineActions
        api={api as never}
        machine={machine({ id: 'e2', label: 'mac-mini', state: 'version-blocked', action: 'upgrade' })}
      />
      <SshMachineActions api={api as never} machine={machine({ id: 'e3', label: 'old-box' })} />
    </>,
  )
  const names = [...document.querySelectorAll('button')].map((candidate) => candidate.getAttribute('aria-label'))
  // Connect is the machine list's own action, the same for every machine.
  expect(names).toEqual(['Disconnect, build-box', 'Update the Studio server, mac-mini'])
  act(() => button('Disconnect').click())
  expect(calls).toContainEqual(['disconnect', 'e1'])
})

test('adding: suggestions from the SSH config, the resolved route shown before it is saved', async () => {
  machines = []
  await render(<AddSshMachine api={api as never} />)
  expect(document.body.textContent).toContain('From your SSH config:')
  act(() => button('build-box').click())
  await flush()
  expect(calls).toContainEqual(['resolve', 'build-box'])
  expect(document.body.textContent).toContain('dev@192.0.2.10:2222')
  expect(document.body.textContent).toContain('bastion')
  act(() => button('Add build-box').click())
  await flush()
  expect(calls).toContainEqual(['add', { destination: 'build-box' }])
})
