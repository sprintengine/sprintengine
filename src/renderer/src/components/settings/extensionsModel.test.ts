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
    trust: 'trusted',
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
    launch: { status: 'trusted_executable', hasMainEntry: true, expectedToLoad: true, mainLoaded: true, ...launch },
  }
}

test('a running main entry reads Running; one turned on since launch waits on a restart', () => {
  expect(runState(view(), true, undefined)).toBe('running')
  expect(runState(view({ launch: { mainLoaded: false } }), true, undefined)).toBe('pending')
})

test('turning a loaded main entry off says it stops at the next restart; an unloaded one is just Off', () => {
  expect(runState(view(), false, undefined)).toBe('stopping')
  expect(runState(view({ launch: { mainLoaded: false } }), false, undefined)).toBe('off')
})

test('a renderer-only module runs as soon as its window code has loaded', () => {
  const rendererOnly = view({
    launch: { status: 'trusted_manifest_only', hasMainEntry: false, rendererEntry: { availability: 'available' } },
  })
  expect(runState(rendererOnly, true, { status: 'loaded' })).toBe('running')
  expect(runState(rendererOnly, true, undefined)).toBe('pending')
  expect(runState(rendererOnly, false, { status: 'loaded' })).toBe('off')
})

test('a module with no code of its own is On, never Running', () => {
  const manifestOnly = view({ launch: { status: 'trusted_manifest_only', hasMainEntry: false } })
  expect(runState(manifestOnly, true, undefined)).toBe('on')
})

test('failures say Couldn’t start with the reason, whatever the switch says', () => {
  const failed = view({ launch: { status: 'launch_error', message: 'registerMain threw: boom' } })
  expect(runState(failed, true, undefined)).toBe('failed')
  expect(problemText(moduleProblem(failed, undefined)!)).toBe('registerMain threw: boom')
  expect(runState(view(), true, { status: 'error', message: 'bad bundle' })).toBe('failed')
  expect(problemText(moduleProblem(view(), undefined, 'crashed while rendering')!)).toBe('crashed while rendering')
})

test('an invalid signature can never be trusted, and the row says so', () => {
  const invalid = view({ trust: 'invalid', launch: { status: 'blocked_invalid' } })
  expect(moduleProblem(invalid, undefined)).toEqual({ kind: 'invalid' })
  expect(problemText({ kind: 'invalid' })).toMatch(/can’t be trusted/)
})

test('the restart line counts trusted, enabled main entries that did not load this session', () => {
  const waiting = view({ manifest: { id: 'acme.radar', displayName: 'PR Radar' }, launch: { mainLoaded: false } })
  const running = view({ manifest: { id: 'log', displayName: 'Decision Log' } })
  const untrusted = view({
    trust: 'unsigned',
    manifest: { id: 'u' },
    launch: { status: 'blocked_unsigned', mainLoaded: false },
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
  expect(moduleMeta(view({ fingerprint: 'f'.repeat(64) }))).toBe('acme · Signed')
  expect(moduleMeta(view({ trust: 'unsigned', manifest: { id: 'local.radar', publisher: 'local' } }))).toBe(
    'Local build · Unsigned',
  )
  expect(moduleMeta(view({ trust: 'signed', fingerprint: 'f'.repeat(64) }))).toBe('acme · Signed')
  expect(moduleMeta(view({ trust: 'invalid' }))).toBe('acme · Invalid signature')
})

test('a trusted extension is signed only when its extension.sig named a signer', () => {
  expect(isSigned(view({ fingerprint: 'f'.repeat(64) }))).toBe(true)
  expect(isSigned(view())).toBe(false)
  expect(signatureLabel(view())).toBe('Unsigned')
  expect(isSigned(view({ trust: 'signed' }))).toBe(true)
  expect(isSigned(view({ trust: 'unsigned', fingerprint: 'f'.repeat(64) }))).toBe(false)
  expect(sourceLabel(view())).toBeNull()
  expect(sourceLabel(view({ manifest: { publisher: 'local' } }))).toBe('Local build')
  expect(publisherName({ publisher: 'local' })).toBeNull()
  expect(publisherName({ publisher: ' acme ' })).toBe('acme')
})

test('access splits into what needs care and the rest, with short titles', () => {
  const { care, standard } = accessItems(['storage', 'github', 'network'])
  expect(care.map((item) => item.title)).toEqual(['Uses your GitHub sign-in', 'Uses the network'])
  expect(care.every((item) => item.why)).toBe(true)
  expect(standard).toEqual([{ id: 'storage', title: 'Saves its own data' }])
})

test('filters: review is the untrusted, on/off the trusted by their switch, and built-ins never need review', () => {
  const trusted = view()
  const untrusted = view({ trust: 'signed' })
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
