// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { EnvironmentEntry } from '../../../../shared/environments'
import type { HostsListResult } from '../../../../shared/execution-host'
import { adoptExtensionsDouble } from '../../studio/extensions.double'

// What the window's Studio is extended with: answered from this test's own stand-in for the window.
vi.mock('../../studio/extensions', () => import('../../studio/extensions.double'))
adoptExtensionsDouble(() => (window as unknown as { api?: object }).api)

// Settings ▸ Agents' machine switcher and Settings ▸ Machines' link into it,
// wired together through the panel itself. Every IPC the panel reaches for on
// mount answers "nothing" unless a test names it: a subscription returns its
// unsubscribe, anything else a promise of undefined.

let listing: HostsListResult
let platform: string
const probes: unknown[] = []

/** Main's list of machines: this PC and the distribution turned on. */
function environments(): EnvironmentEntry[] {
  const up = { state: 'up' as const, detail: null, lastReachedAt: null }
  return [
    {
      environmentId: 'env-local',
      displayName: 'This PC (Windows)',
      routes: [{ kind: 'local' }],
      machine: { kind: 'local' },
      descriptor: null,
      connection: up,
      compatibility: 'unknown',
    },
    {
      environmentId: null,
      displayName: 'WSL: Ubuntu',
      routes: [{ kind: 'wsl', distro: 'Ubuntu' }],
      machine: { kind: 'wsl', hostId: 'wsl:Ubuntu' },
      descriptor: null,
      connection: up,
      compatibility: 'unknown',
    },
  ]
}

function stubApi(): void {
  const named: Record<string, unknown> = {
    hostsList: async () => listing,
    onHostsChanged: () => () => {},
    pluginsDetectAvailability: async (input: unknown) => {
      probes.push(input)
      return { ok: true, availability: {} }
    },
    pluginsList: async () => ({ ok: true, plugins: [] }),
    getGitHubTokenStatus: async () => ({ configured: false }),
    environmentsList: async () => environments(),
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(named, {
    get(target, key) {
      if (key === 'platform') return platform
      if (typeof key !== 'string') return undefined
      if (key in target) return target[key]
      return key.startsWith('on') ? () => () => {} : async () => undefined
    },
  })
}

const { default: SettingsPanel } = await import('./SettingsPanel')
const { ConfirmDialogProvider } = await import('../ui/ConfirmDialog')
const { useWorkspaceStore } = await import('../../store/workspaceStore')
const { rememberAgentsMachine } = await import('./agentsMachine')
const { resetEnvironmentsForTests } = await import('../../hooks/useEnvironments')

function Panel({ initialTab }: { initialTab: string }): React.JSX.Element {
  return (
    <ConfirmDialogProvider>
      <SettingsPanel onClose={() => {}} initialTab={initialTab} />
    </ConfirmDialogProvider>
  )
}

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  probes.length = 0
  resetEnvironmentsForTests()
  // Both outlive a test: the store is the app's one store, and the machine the
  // window last showed is module state.
  rememberAgentsMachine('local')
  useWorkspaceStore.getState().setHostSettings('wsl:Ubuntu', null)
  useWorkspaceStore.setState({ pluginCatalogEntries: [] })
  platform = 'win32'
  listing = {
    hosts: [
      { id: 'local', kind: 'windows', label: 'This PC (Windows)', pathStyle: 'windows', state: 'ready' },
      { id: 'wsl:Ubuntu', kind: 'wsl', label: 'WSL: Ubuntu', pathStyle: 'wsl', state: 'ready', enabled: true },
    ],
    wsl: { available: true },
  }
  stubApi()
  window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0)) as unknown as typeof requestAnimationFrame
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
}

function machineSwitcher(): HTMLElement | null {
  return host.querySelector('[role="radiogroup"][aria-label="Machine"]')
}

function checkedMachine(): string | null | undefined {
  return machineSwitcher()?.querySelector('[role="radio"][aria-checked="true"]')?.textContent
}

// A probe that names a WSL machine. This machine's own probe is the store's,
// and runs whichever machine is shown.
function wslProbes(): unknown[] {
  return probes.filter((probe) => JSON.stringify(probe).includes('"hostId":"wsl:'))
}

test('the Machines tab’s link opens Agents with that machine picked', async () => {
  useWorkspaceStore.getState().setHostSettings('wsl:Ubuntu', { enabled: true, cliCommands: {}, env: {} })
  useWorkspaceStore.setState({
    pluginCatalogStatus: 'ready',
    pluginCatalogEntries: [
      { id: 'codex', kind: 'cli', displayName: 'Codex', binary: 'codex', source: 'bundled' },
    ] as unknown as ReturnType<typeof useWorkspaceStore.getState>['pluginCatalogEntries'],
  })
  await act(async () => root.render(<Panel initialTab="machines" />))
  await settle()
  const link = host.querySelector<HTMLButtonElement>('button[aria-label="Agent CLIs on this machine, WSL: Ubuntu"]')
  expect(link).toBeTruthy()
  await act(async () => link!.click())
  await settle()

  expect(host.querySelector('#settings-panel-agents')).toBeTruthy()
  expect(checkedMachine()).toBe('WSL: Ubuntu')
  // And the list below it asks that machine.
  expect(wslProbes().length).toBeGreaterThan(0)

  // Back to this PC from the switcher itself.
  const thisPc = Array.from(machineSwitcher()!.querySelectorAll<HTMLButtonElement>('[role="radio"]'))[0]
  await act(async () => thisPc.click())
  expect(checkedMachine()).toBe('This PC (Windows)')
})

test('with one machine the Agents tab draws no switcher', async () => {
  platform = 'darwin'
  listing = {
    hosts: [{ id: 'local', kind: 'posix', label: 'This Mac', pathStyle: 'posix', state: 'ready' }],
    wsl: null,
  }
  await act(async () => root.render(<Panel initialTab="agents" />))
  await settle()
  expect(host.querySelector('#settings-panel-agents')).toBeTruthy()
  expect(machineSwitcher()).toBe(null)
  expect(wslProbes()).toEqual([])
})

test('a Windows PC with no distribution turned on draws no switcher either', async () => {
  listing = {
    ...listing,
    hosts: listing.hosts.map((entry) => (entry.kind === 'wsl' ? { ...entry, enabled: false } : entry)),
  }
  await act(async () => root.render(<Panel initialTab="agents" />))
  await settle()
  expect(machineSwitcher()).toBe(null)
})
