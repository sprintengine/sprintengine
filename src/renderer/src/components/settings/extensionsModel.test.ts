import { expect, test } from 'vitest'

import type {
  CapabilityManifest,
  ThirdPartyModuleLaunchView,
  ThirdPartyModuleView,
} from '../../../../shared/modules/manifest'
import {
  accessItems,
  builtInMatchesFilter,
  moduleMatchesFilter,
  moduleMatchesQuery,
  isSigned,
  moduleMeta,
  moduleProblem,
  modulesAwaitingRestart,
  problemText,
  publisherName,
  resolveModuleEnabled,
  restartBannerTitle,
  RUN_STATE_LABEL,
  runState,
  signatureLabel,
  sourceLabel,
} from './extensionsModel'

function view(
  overrides: Partial<Omit<ThirdPartyModuleView, 'manifest' | 'launch'>> & {
    manifest?: Partial<CapabilityManifest>
    launch?: Partial<ThirdPartyModuleLaunchView>
  } = {},
): ThirdPartyModuleView {
  const { manifest, launch, ...rest } = overrides
  return {
    approval: { state: 'approved', fingerprint: 'sha256-test' },
    signature: 'unsigned',
    extension: {
      manifestVersion: 1,
      id: 'radar',
      version: '1.0.0',
      engines: { studio: '>=0.13.0' },
      tier: 'worker',
      name: 'PR Radar',
      permissions: [],
      main: 'dist/main.cjs',
      contributes: {
        commands: [],
        menus: [],
        topBarItems: [],
        panels: [],
        doors: [],
        settingsSections: [],
        mcpTools: [],
        syntaxes: [],
        keybindings: [],
        statusBarItems: [],
        settings: [],
      },
    },
    ...rest,
    manifest: {
      id: 'acme.radar',
      displayName: 'PR Radar',
      version: '1.0.0',
      publisher: 'acme',
      defaultEnabled: true,
      source: 'third-party',
      ...manifest,
    },
    launch: { status: 'runs_worker', hasMainEntry: true, expectedToLoad: true, mainLoaded: true, ...launch },
  }
}

test('a running main entry reads Running; one turned on since launch waits on a restart', () => {
  expect(runState(view(), true, undefined)).toBe('running')
  expect(runState(view({ launch: { mainLoaded: false } }), true, undefined)).toBe('pending')
})

test('a worker waiting for a place reads Waiting to start, not Running', () => {
  const waiting = view({ launch: { waiting: 'Waiting to start: 16 extensions already run in the background.' } })
  expect(runState(waiting, true, undefined)).toBe('waiting')
  expect(RUN_STATE_LABEL.waiting).toBe('Waiting to start')
  expect(runState(waiting, false, undefined)).toBe('off')
})

test('turning a worker off reads Off at once: it stops then, not at the next restart', () => {
  expect(runState(view(), false, undefined)).toBe('off')
  expect(runState(view({ launch: { mainLoaded: false } }), false, undefined)).toBe('off')
})

test('a renderer-only module runs as soon as its window code has loaded', () => {
  const rendererOnly = view({
    launch: { status: 'runs_without_worker', hasMainEntry: false, rendererEntry: { availability: 'available' } },
  })
  expect(runState(rendererOnly, true, { status: 'loaded' })).toBe('running')
  expect(runState(rendererOnly, true, undefined)).toBe('pending')
  expect(runState(rendererOnly, false, { status: 'loaded' })).toBe('off')
})

test('a module with no code of its own is On, never Running', () => {
  const manifestOnly = view({ launch: { status: 'runs_without_worker', hasMainEntry: false } })
  expect(runState(manifestOnly, true, undefined)).toBe('on')
})

test('failures say Couldn’t start with the reason, whatever the switch says', () => {
  const failed = view({ launch: { status: 'launch_error', message: 'registerMain threw: boom' } })
  expect(runState(failed, true, undefined)).toBe('failed')
  expect(problemText(moduleProblem(failed, undefined)!)).toBe('registerMain threw: boom')
  expect(runState(view(), true, { status: 'error', message: 'bad bundle' })).toBe('failed')
  expect(problemText(moduleProblem(view(), undefined, 'crashed while rendering')!)).toBe('crashed while rendering')
})

test('an invalid signature can never be approved, and the row says so', () => {
  const invalid = view({ signature: 'invalid', launch: { status: 'blocked_invalid' } })
  expect(moduleProblem(invalid, undefined)).toEqual({ kind: 'invalid' })
  expect(problemText({ kind: 'invalid' })).toMatch(/can’t be approved/)
})

test('the restart line counts approved, enabled main entries that did not load this session', () => {
  const waiting = view({ manifest: { id: 'acme.radar', displayName: 'PR Radar' }, launch: { mainLoaded: false } })
  const running = view({ manifest: { id: 'log', displayName: 'Decision Log' } })
  const untrusted = view({
    approval: { state: 'pending', fingerprint: 'sha256-test' },
    manifest: { id: 'u' },
    launch: { status: 'awaiting_approval', mainLoaded: false },
  })
  const failed = view({ manifest: { id: 'f' }, launch: { status: 'launch_error', mainLoaded: false } })
  const off = view({ manifest: { id: 'off', defaultEnabled: false }, launch: { mainLoaded: false } })
  const all = [waiting, running, untrusted, failed, off]
  const enabledFor = (module: ThirdPartyModuleView) => resolveModuleEnabled({}, module)

  const one = modulesAwaitingRestart(all, enabledFor)
  expect(one.map((module) => module.manifest.id)).toEqual(['acme.radar'])
  expect(restartBannerTitle(one)).toBe('Restart Studio to start PR Radar')

  const two = modulesAwaitingRestart(all, (module) => module.manifest.id === 'off' || enabledFor(module))
  expect(restartBannerTitle(two)).toBe('Restart Studio to start 2 extensions')
  expect(restartBannerTitle([])).toBeNull()
})

test('the meta line is publisher · source · signature, and a folder install names no publisher', () => {
  expect(moduleMeta(view({ signature: 'signed', signer: 'f'.repeat(64) }))).toBe('acme · Signed')
  expect(moduleMeta(view({ manifest: { id: 'local.radar', publisher: 'local' } }))).toBe('Local build · Unsigned')
  expect(moduleMeta(view({ signature: 'verified', signer: 'f'.repeat(64) }))).toBe('acme · Verified')
  expect(moduleMeta(view({ signature: 'invalid' }))).toBe('acme · Invalid signature')
})

test('an extension is signed when its extension.sig checked out, verified or not', () => {
  expect(isSigned(view({ signature: 'signed' }))).toBe(true)
  expect(isSigned(view({ signature: 'verified' }))).toBe(true)
  expect(isSigned(view())).toBe(false)
  expect(signatureLabel(view())).toBe('Unsigned')
  expect(isSigned(view({ signature: 'invalid' }))).toBe(false)
  expect(sourceLabel(view())).toBeNull()
  expect(sourceLabel(view({ manifest: { publisher: 'local' } }))).toBe('Local build')
  expect(publisherName({ publisher: 'local' })).toBeNull()
  expect(publisherName({ publisher: ' acme ' })).toBe('acme')
})

test('access splits into what needs care and the rest, with short titles', () => {
  const { care, standard } = accessItems(['storage:own', 'github:api', 'conversation:read'])
  expect(care.map((item) => item.title)).toEqual(['Uses your GitHub sign-in', 'Reads all your chats'])
  expect(care.every((item) => item.why)).toBe(true)
  expect(standard).toEqual([{ id: 'storage:own', title: 'Saves its own data' }])
})

test('filters: review is the unapproved, on/off the approved by their switch, and built-ins never need review', () => {
  const trusted = view()
  const untrusted = view({ approval: { state: 'pending', fingerprint: 'sha256-test' } })
  expect(moduleMatchesFilter(untrusted, 'review', false)).toBe(true)
  expect(moduleMatchesFilter(trusted, 'review', true)).toBe(false)
  expect(moduleMatchesFilter(trusted, 'on', true)).toBe(true)
  expect(moduleMatchesFilter(trusted, 'off', true)).toBe(false)
  expect(moduleMatchesFilter(untrusted, 'off', false)).toBe(false)
  expect(builtInMatchesFilter('review', true)).toBe(false)
  expect(builtInMatchesFilter('off', false)).toBe(true)
  expect(moduleMatchesQuery(view({ manifest: { summary: 'Open pull requests' } }), 'PULL')).toBe(true)
  expect(moduleMatchesQuery(view(), 'weather')).toBe(false)
})
