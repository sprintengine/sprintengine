// @vitest-environment jsdom
//
// Settings → Extensions, driven the way a person does: review and approve,
// the one switch, the glyphs and what they name, the details (what its
// extension.json declares), the restart line, the filters, the folded
// built-ins, install from a folder, and uninstall through the Studio.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { CapabilityManifest, ThirdPartyModuleView } from '../../../../shared/modules/manifest'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { ConfirmDialogProvider } from '../ui/ConfirmDialog'
import { ModulesSettingsTab } from './ModulesSettingsTab'
import { COMING_SOON_IDS, MODULE_CATEGORY_GROUPS } from './ModuleControls'
import type { StudioModuleSummary } from '../../../../../packages/studio-protocol/src/public'
import { adoptExtensionsDouble } from '../../studio/extensions.double'
import { requestExtensionPage } from './extensionPageRequest'

// What the window's Studio is extended with: answered from this test's own stand-in for the window.
vi.mock('../../studio/extensions', () => import('../../studio/extensions.double'))
adoptExtensionsDouble(() => (window as unknown as { api?: object }).api)

const registry = {
  getWorkspaceTypeModule: () => null,
}

vi.mock('../../modules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../modules')>()),
  getRendererHost: () => registry,
  onThirdPartyRendererModulesLoaded: () => () => {},
  refreshThirdPartyRendererModules: async () => {},
}))

// What runs on the window's Studio is changed through it (`extension.approve`,
// `extension.uninstall`); this stands in for the window's connection.
vi.mock('../../studio/moduleLifecycle', () => ({
  windowModuleLifecycle: () => ({
    setEnabled: async (id: string, enabled: boolean | null) => {
      enableCalls.push([id, enabled])
      return setEnabledAnswer
    },
    install: async () => installAnswer,
    approve: async (id: string, fingerprint: string) => {
      approveCalls.push([id, fingerprint])
      return { ok: true }
    },
    installFrom: async (from: unknown) => {
      installFromCalls.push(from)
      return { ok: false, message: 'not here' }
    },
    update: async (id: string) => {
      updateCalls.push(id)
      return { ok: false, message: 'not here' }
    },
    addCatalogue: async (url: string) => {
      addCatalogueCalls.push(url)
      return { ok: true, catalogue: { id: `git:${url}`, kind: 'added', name: 'Acme', url, entries: [] } }
    },
    removeCatalogue: async () => ({ ok: true }),
    uninstall: async (id: string) => {
      uninstallCalls.push(id)
      installed = installed.filter((candidate) => candidate.manifest.id !== id)
      return { ok: true, removedModuleIds: [id] }
    },
  }),
}))

// The catalogues the window's Studio reads: one community listing.
vi.mock('../../studio/extensionCatalogue', () => ({
  extensionCatalogueApi: {
    catalogues: async () => [
      { id: 'official', kind: 'official', name: 'Official', entries: [] },
      { id: 'community', kind: 'community', name: 'Community', entries: [NOTES_LISTING] },
    ],
    entry: async (catalogue: string, id: string) => {
      catalogueEntryCalls.push([catalogue, id])
      return {
        ok: true,
        entry: {
          ...NOTES_LISTING,
          catalogue,
          catalogueName: 'Community',
          source: { url: 'https://github.com/acme/notes.git', ref: 'main' },
          commit: 'a'.repeat(40),
          releases: [{ version: '1.0.0', minimumStudio: '0.13.0' }],
          alsoListedBy: [],
        },
      }
    },
    image: async () => null,
  },
}))

vi.mock('../../modules/extension-contributions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../modules/extension-contributions')>()),
  getExtensionContributionsState: (id: string) => (id === 'local.decision-log' ? { status: 'loaded' } : undefined),
}))

type Contributes = ThirdPartyModuleView['extension']['contributes']

function module(
  id: string,
  displayName: string,
  overrides: Partial<Omit<ThirdPartyModuleView, 'manifest' | 'launch' | 'extension'>> & {
    manifest?: Partial<CapabilityManifest>
    launch?: Partial<ThirdPartyModuleView['launch']>
    contributes?: Partial<Contributes>
  } = {},
): ThirdPartyModuleView {
  const { manifest, launch, contributes, ...rest } = overrides
  const [publisher, extensionId] = id.split('.') as [string, string]
  return {
    approval: { state: 'approved', fingerprint: 'sha256-ok' },
    signature: 'unsigned',
    mcpTools: [],
    extension: {
      manifestVersion: 1,
      id: extensionId,
      version: '1.0.0',
      engines: { studio: '>=0.13.0' },
      tier: 'worker',
      name: displayName,
      permissions: [...(manifest?.permissions ?? [])],
      main: 'dist/main.cjs',
      contributes: {
        commands: [],
        menus: [],
        topBarItems: [],
        panels: [],
        doors: [],
        settingsSections: [],
        mcpTools: [],
        hooks: [],
        syntaxes: [],
        customEditors: [],
        keybindings: [],
        statusBarItems: [],
        settings: [],
        skills: [],
        mcpServers: [],
        providers: [],
        ...contributes,
      },
    },
    ...rest,
    manifest: {
      id,
      displayName,
      version: '1.0.0',
      publisher,
      defaultEnabled: true,
      source: 'third-party',
      ...manifest,
    },
    launch: {
      status: 'runs_worker',
      hasMainEntry: true,
      expectedToLoad: true,
      mainLoaded: true,
      rendererEntry: { availability: 'available' },
      ...launch,
    },
  }
}

const INSIGHTS = module('acme.insights', 'Insights', {
  approval: { state: 'pending', fingerprint: 'sha256-insights' },
  launch: { status: 'awaiting_approval', mainLoaded: false },
  manifest: {
    summary: 'Usage and equivalent API cost across your chats, and prompt coaching every morning.',
    permissions: ['conversation:own', 'conversation:read', 'github:api', 'storage:own'],
  },
})
const SIGNED = module('acme.kanban', 'Task Board', {
  approval: { state: 'pending', fingerprint: 'sha256-kanban', growth: ['the "backlog:operate" permission'] },
  signature: 'signed',
  signer: 'f'.repeat(64),
  launch: { status: 'awaiting_approval', mainLoaded: false },
  manifest: { permissions: ['backlog:read', 'backlog:operate'] },
})
const DECISION_LOG = module('local.decision-log', 'Decision Log', {
  mcpTools: ['decisions_record', 'decisions_search'],
  manifest: { summary: 'Durable decisions.', permissions: ['tools:contribute', 'storage:own', 'conversation:read'] },
  contributes: {
    doors: [{ id: 'decisions', title: 'Decisions', icon: 'notes', entry: 'dist/decisions.js' }],
    commands: [
      { id: 'decisions.record', title: 'Record a decision' },
      { id: 'decisions.backlog', title: 'Open Backlog', action: 'panel.backlog.toggle' },
    ],
    mcpTools: [
      { name: 'decisions_record', description: 'Record one.', access: 'operate' },
      { name: 'decisions_search', description: 'Search them.', access: 'read' },
    ],
  },
})
const PR_RADAR = module('acme.pr-radar', 'PR Radar', {
  signature: 'signed',
  signer: 'e'.repeat(64),
  launch: { mainLoaded: false },
  manifest: { permissions: ['github:api'] },
})
const TAMPERED = module('acme.tampered', 'Tampered', {
  approval: { state: 'unavailable' },
  signature: 'invalid',
  launch: { status: 'blocked_invalid', mainLoaded: false },
})

const NOTES_LISTING = {
  id: 'acme.notes',
  name: 'Notes',
  publisher: 'acme',
  description: 'Take notes.',
  categories: ['productivity'],
  version: '1.0.0',
  installable: true,
  tier: 'declarative' as const,
  permissions: [],
  contributes: [{ kind: 'skills', name: 'notes' }],
  label: 'Community · acme',
}

let installed: ThirdPartyModuleView[] = []
let installAnswer:
  | { ok: true; moduleId: string; approval: { state: 'pending'; fingerprint: string }; strippedLinks: string[] }
  | { ok: false; message: string } = {
  ok: false,
  message: 'not here',
}
let openDirAnswer: string | null = null
const enableCalls: Array<[string, boolean | null]> = []
let setEnabledAnswer: { ok: true; module: null } | { ok: false; message: string } = { ok: true, module: null }
const approveCalls: Array<[string, string]> = []
const uninstallCalls: string[] = []
const installFromCalls: unknown[] = []
const updateCalls: string[] = []
const addCatalogueCalls: string[] = []
const catalogueEntryCalls: Array<[string, string]> = []
const restartApp = vi.fn(async () => ({ restarting: false }))
let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  installed = [INSIGHTS, SIGNED, DECISION_LOG, PR_RADAR, TAMPERED]
  installAnswer = { ok: false, message: 'not here' }
  openDirAnswer = null
  approveCalls.length = 0
  enableCalls.length = 0
  setEnabledAnswer = { ok: true, module: null }
  uninstallCalls.length = 0
  installFromCalls.length = 0
  updateCalls.length = 0
  addCatalogueCalls.length = 0
  catalogueEntryCalls.length = 0
  restartApp.mockClear()
  ;(window as unknown as { api: unknown }).api = {
    listThirdPartyModules: async () => ({ modules: installed, rejected: [] }),
    openDir: async () => openDirAnswer,
    restartApp,
    clipboardWriteText: async () => undefined,
  }
  useWorkspaceStore.setState((state) => ({
    appSettings: {
      ...state.appSettings,
      modules: { 'local.decision-log': true, 'acme.other-ext': false },
      moduleSettings: { 'module:local.decision-log': { theme: 'dark' } },
    },
  }))
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
  document.body.innerHTML = ''
})

async function mount(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  const created = createRoot(host)
  root = created
  await act(async () =>
    created.render(
      <ConfirmDialogProvider>
        <ModulesSettingsTab />
      </ConfirmDialogProvider>,
    ),
  )
  await act(async () => {})
}

const panel = () => document.getElementById('settings-panel-modules')!
const buttons = (scope: ParentNode = document) => [...scope.querySelectorAll('button')] as HTMLButtonElement[]
const button = (name: string, scope: ParentNode = document) =>
  buttons(scope).find(
    (candidate) => candidate.getAttribute('aria-label') === name || candidate.textContent?.trim() === name,
  )
const list = (label: string) => panel().querySelector(`ul[aria-label="${label}"]`)
const rowOf = (name: string) =>
  [...panel().querySelectorAll('li')].find((li) => li.querySelector('button')?.textContent?.trim() === name)!
const click = async (element: Element | undefined | null) => {
  expect(element).toBeTruthy()
  await act(async () => (element as HTMLElement).click())
  await act(async () => {})
}
const modal = () => document.querySelector('[role="dialog"][aria-modal="true"]')

test('the page is Extensions, with Browse and an Install menu, and says nothing about itself', async () => {
  await mount()
  expect(panel().querySelector('h3')?.textContent).toBe('Extensions')
  expect(button('Browse', panel())).toBeTruthy()
  await click(button('Install', panel()))
  const menu = document.querySelector('[role="menu"][aria-label="Install"]')!
  expect([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim())).toEqual([
    'From a folder',
    'As a development folder',
    'From a git URL',
    'From a catalogue',
  ])
  // No trailing ellipsis on any label.
  expect(buttons().some((candidate) => (candidate.textContent?.trim() ?? '').endsWith('…'))).toBe(false)
})

test('extensions waiting for approval come first under Needs review, each with Review and no switch', async () => {
  await mount()
  const review = list('Needs review')!
  expect([...review.querySelectorAll(':scope > li')].length).toBe(3)
  expect(review.querySelectorAll('[role="switch"]').length).toBe(0)
  expect(button('Review Insights', review)).toBeTruthy()
  // An invalid signature can never be approved: words, and no Review.
  const tampered = rowOf('Tampered')
  expect(tampered.textContent).toContain('Can’t be approved')
  expect(button('Review Tampered', tampered)).toBeUndefined()
})

test('review says the code runs with full access, and approves the fingerprint it showed and turns on in one step', async () => {
  await mount()
  await click(button('Review Insights'))
  const dialog = modal()!
  expect(dialog.textContent).toContain('Approve Insights?')
  expect(dialog.textContent).toContain('on this machine with full access')
  expect(dialog.textContent).toContain('its own code is not limited')
  expect(dialog.textContent).toContain('Needs care')
  expect(dialog.textContent).toContain('Runs chats with your agents')
  expect(dialog.textContent).toContain('Starts, messages and stops chats')
  expect(dialog.querySelector('ul[aria-label="Also"]')?.textContent).toContain('Saves its own data')
  // Approving loads it at once: nothing says it waits for a restart.
  expect(dialog.textContent).not.toContain('restart')
  // A signature is a badge, not a gate: no box to tick.
  expect(dialog.querySelector('input[type="checkbox"]')).toBeNull()
  const approve = button('Approve and turn on', dialog)!
  expect(approve.disabled).toBe(false)
  await click(approve)

  expect(approveCalls).toEqual([['acme.insights', 'sha256-insights']])
  expect(useWorkspaceStore.getState().appSettings.modules['acme.insights']).toBe(true)
  expect(modal()).toBeNull()
})

test('an update that asks for more says what is new before it is approved again', async () => {
  await mount()
  await click(button('Review Task Board'))
  const dialog = modal()!
  expect(dialog.textContent).toContain('Approve Task Board again?')
  expect(dialog.querySelector('section[aria-label="New in this version"]')?.textContent).toContain(
    'the "backlog:operate" permission',
  )
})

test('an installed extension has one switch, its state in words, and no approval switch', async () => {
  await mount()
  const row = rowOf('Decision Log')
  const switches = row.querySelectorAll('[role="switch"]')
  expect(switches.length).toBe(1)
  expect(switches[0]!.getAttribute('aria-label')).toBe('Enable Decision Log')
  expect(row.textContent).toContain('Running')
  expect(rowOf('PR Radar').textContent).toContain('Starts after restart')
  await click(switches[0])
  expect(useWorkspaceStore.getState().appSettings.modules['local.decision-log']).toBe(false)
})

test('sensitive access is one glyph per scope, named in full, listed on hover', async () => {
  await mount()
  const glyphs = rowOf('Insights').querySelector('[role="img"][aria-label^="Insights needs care"]') as HTMLElement
  expect(glyphs.getAttribute('aria-label')).toBe(
    'Insights needs care: Runs chats with your agents, Reads all your chats, Uses your GitHub sign-in',
  )
  expect(glyphs.querySelectorAll('svg').length).toBe(3)
  // The row never carries the consent sentences themselves.
  expect(rowOf('Insights').textContent).not.toContain('including what you and the agents wrote')
  await act(async () => {
    glyphs.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }))
    await new Promise((resolve) => setTimeout(resolve, 260))
  })
  const tip = document.querySelector('[role="tooltip"]')
  expect(tip?.textContent).toContain('Reads all your chats')
  expect(tip?.querySelectorAll('li').length).toBe(3)
})

test('the full summary is on the row, never clipped to a line', async () => {
  await mount()
  const summary = [...rowOf('Insights').querySelectorAll('p')].find((p) => p.textContent?.startsWith('Usage'))!
  expect(summary.className).not.toMatch(/truncate|line-clamp/)
})

test('the name opens the details: what it adds, its access with ids, and the facts', async () => {
  await mount()
  await click(button('Decision Log'))
  const details = document.querySelector('[role="dialog"][aria-label="Decision Log details"]')!
  expect(details).toBeTruthy()
  const adds = details.querySelector('section[aria-label="Adds"]')!
  expect([...adds.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
    'Decisions door',
    '2 commands',
    '2 agent tools',
  ])
  expect(details.textContent).toContain('conversation:read')
  expect(details.textContent).toContain('Unsigned')
  expect(details.textContent).toContain('Local build')
  expect(details.textContent).toContain('By you')
  // Escape closes it and hands focus back to the name.
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect(document.querySelector('[aria-label="Decision Log details"]')).toBeNull()
  expect(document.activeElement?.textContent).toBe('Decision Log')
})

test('an unapproved extension’s details offer Review and approve, and say what it declares before any code runs', async () => {
  installed = installed.map((candidate) =>
    candidate === INSIGHTS
      ? {
          ...INSIGHTS,
          extension: {
            ...INSIGHTS.extension,
            contributes: {
              ...INSIGHTS.extension.contributes,
              panels: [{ id: 'usage', title: 'Usage', entry: 'dist/usage.js' }],
            },
          },
        }
      : candidate,
  )
  await mount()
  await click(button('Insights'))
  const details = document.querySelector('[aria-label="Insights details"]')!
  expect([...details.querySelectorAll('section[aria-label="Adds"] li')].map((li) => li.textContent)).toEqual([
    'Usage panel',
  ])
  expect(details.textContent).toContain('Not approved')
  expect(button('Review and approve', details)).toBeTruthy()
})

test('a signed extension’s details name its key; a publisher’s own reads as its publisher', async () => {
  await mount()
  await click(button('PR Radar'))
  const details = document.querySelector('[aria-label="PR Radar details"]')!
  expect(details.textContent).toContain('Signed by acme')
  expect(details.textContent).not.toContain('Local build')
})

test('the restart line names what waits on the next launch and offers one primary action', async () => {
  await mount()
  const banner = panel().querySelector('[role="status"]')!
  expect(banner.textContent).toContain('Restart Studio to start PR Radar')
  await click(button('Restart now', banner))
  expect(restartApp).toHaveBeenCalledTimes(1)
  await click(button('Later', banner))
  expect(panel().textContent).not.toContain('Restart Studio to start')
})

test('filters and search narrow the groups', async () => {
  await mount()
  await click(panel().querySelector('[role="radio"][aria-label^="Needs review"]'))
  expect(list('Needs review')).toBeTruthy()
  expect(list('Installed')).toBeNull()
  expect(list('Built in')).toBeNull()

  await click(panel().querySelector('[role="radio"]'))
  const input = panel().querySelector<HTMLInputElement>('input[aria-label="Search extensions"]')!
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, 'radar')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(list('Needs review')).toBeNull()
  expect([...list('Installed')!.querySelectorAll(':scope > li')].length).toBe(1)
})

test('built-in modules are folded away until asked for', async () => {
  await mount()
  const toggle = button('Built in', panel())!
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(list('Built in')!.closest('[hidden]')).toBeTruthy()
  await click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(list('Built in')!.closest('[hidden]')).toBeNull()
  expect(list('Built in')!.textContent).toContain('Always on')
})

test('a built-in row shows what the Studio runs, and a switch the Studio refused says so and changes nothing', async () => {
  const manifest = MODULE_CATEGORY_GROUPS.flatMap((group) => group.manifests).find(
    (candidate) => !candidate.core && !COMING_SOON_IDS.has(candidate.id),
  )!
  // The window's copy says off; the Studio holds it on, and it does not run there.
  useWorkspaceStore.getState().setModuleEnabled(manifest.id, false)
  const api = (window as unknown as { api: Record<string, unknown> }).api
  api.listStudioModules = async (): Promise<StudioModuleSummary[]> => [
    {
      id: manifest.id,
      name: manifest.displayName,
      version: manifest.version,
      source: 'bundled',
      enabled: true,
      running: false,
      blocked: 'A module it needs is switched off.',
      methods: [],
    },
  ]
  await mount()
  await click(button('Built in', panel()))
  const row = [...list('Built in')!.querySelectorAll('li')].find((li) =>
    li.textContent?.includes(manifest.displayName),
  )!
  expect(row.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true')
  expect(row.querySelector('[data-testid="module-not-running"]')?.textContent).toBe(
    'A module it needs is switched off.',
  )
  expect(useWorkspaceStore.getState().appSettings.modules?.[manifest.id]).toBe(true)

  setEnabledAnswer = { ok: false, message: 'The choice could not be saved.' }
  await click(row.querySelector('[role="switch"]'))
  expect(enableCalls).toContainEqual([manifest.id, false])
  expect(panel().textContent).toContain('The choice could not be saved.')
  expect(useWorkspaceStore.getState().appSettings.modules?.[manifest.id]).toBe(true)
})

test('a module added from a folder is uninstalled by the Studio, and forgotten here', async () => {
  await mount()
  await click(button('More for Decision Log'))
  await click([...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === 'Uninstall'))
  const confirm = buttons(modal()!).find((candidate) => candidate.textContent?.trim() === 'Uninstall')
  expect(document.body.textContent).toContain('Work it saved in your projects stays')
  await click(confirm)

  expect(uninstallCalls).toEqual(['local.decision-log'])
  const settings = useWorkspaceStore.getState().appSettings
  expect(settings.modules).toEqual({ 'acme.other-ext': false })
  expect(settings.moduleSettings?.['module:local.decision-log']).toBeUndefined()
  expect(rowOf('PR Radar')).toBeTruthy()
  expect(panel().textContent).not.toContain('Decision Log')
})

test('a folder install that left symbolic links out says which', async () => {
  openDirAnswer = '/Users/dev/extensions/notes'
  installAnswer = {
    ok: true,
    moduleId: 'local.notes',
    approval: { state: 'pending', fingerprint: 'sha256-notes' },
    strippedLinks: ['dist/shared.js'],
  }
  await mount()
  await click(button('Install', panel()))
  await click(
    [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.trim() === 'From a folder'),
  )
  expect(panel().textContent).toContain('Symbolic links were left out: dist/shared.js.')
})

test('a folder install that waits for approval opens its review at once', async () => {
  openDirAnswer = '/Users/dev/extensions/insights'
  installAnswer = {
    ok: true,
    moduleId: 'acme.insights',
    approval: { state: 'pending', fingerprint: 'sha256-insights' },
    strippedLinks: [],
  }
  await mount()
  await click(button('Install', panel()))
  await click(
    [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.trim() === 'From a folder'),
  )
  expect(modal()?.textContent).toContain('Approve Insights?')
})

test('a folder the Studio refuses says why', async () => {
  openDirAnswer = '/Users/dev/extensions/notes'
  installAnswer = { ok: false, message: 'It needs Studio 9.0.0 or newer.' }
  await mount()
  await click(button('Install', panel()))
  await click(
    [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.trim() === 'From a folder'),
  )
  expect(panel().textContent).toContain('It needs Studio 9.0.0 or newer.')
})

test('an install link opens the extension’s page and installs nothing until Install is pressed', async () => {
  requestExtensionPage({ catalogue: 'community', id: 'acme.notes' })
  await mount()
  await act(async () => {})
  const page = panel().querySelector('article[aria-label="Notes"]')
  expect(page).toBeTruthy()
  expect(page?.textContent).toContain('Community · acme')
  expect(catalogueEntryCalls).toEqual([['community', 'acme.notes']])
  expect(installFromCalls).toEqual([])
  await click(button('Install', page!))
  expect(installFromCalls).toEqual([{ catalogue: 'community', id: 'acme.notes' }])
})

test('an install link naming a catalogue not added asks before adding it, and adds nothing when declined', async () => {
  requestExtensionPage({ catalogue: 'git:https://github.com/acme/catalogue.git', id: 'acme.notes' })
  await mount()
  await act(async () => {})
  expect(modal()?.textContent).toContain('Add catalogue https://github.com/acme/catalogue.git?')
  await click(button('Cancel', modal()!))
  expect(addCatalogueCalls).toEqual([])
  expect(catalogueEntryCalls).toEqual([])
  expect(installFromCalls).toEqual([])
})

test('an update held for review says why, and reviewing it closes the details for the approval to show', async () => {
  installed = [{ ...DECISION_LOG, update: { version: '1.1.0', held: 'access', growth: ['the "network" permission'] } }]
  await mount()
  expect(rowOf('Decision Log').textContent).toContain(
    'Version 1.1.0 waits for your review: it asks for the "network" permission.',
  )
  await click(button('Decision Log'))
  const details = document.querySelector('[role="dialog"][aria-label="Decision Log details"]')!
  // A press, as a pointer makes it: down, then the click.
  const review = button('Review version 1.1.0', details)!
  await act(async () => {
    review.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
  await click(review)
  expect(updateCalls).toEqual(['local.decision-log'])
  expect(document.querySelector('[aria-label="Decision Log details"]')).toBeNull()
})

test('a version Studio’s kill list removed says so, with why, and has no switch', async () => {
  installed = [
    {
      ...DECISION_LOG,
      killed: { reason: 'It sends your files away.', advisoryUrl: 'https://example.com/advisory' },
      launch: { ...DECISION_LOG.launch, status: 'killed' },
    },
  ]
  await mount()
  const row = rowOf('Decision Log')
  expect(row.textContent).toContain('Switched off by Studio')
  expect(row.textContent).toContain('its kill list removed this version. It sends your files away.')
  expect(row.querySelector('[role="switch"]')).toBeNull()
})
