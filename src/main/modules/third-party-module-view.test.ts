import assert from 'node:assert/strict'

import { validateExtensionManifest } from '../../../packages/extension-sdk/src/extension-manifest'
import { extensionManifest } from '../../../tests/extension-folder'
import { capabilityManifestOf } from '../../shared/modules/third-party-manifest'
import {
  readThirdPartyMainLaunchSnapshot,
  recordThirdPartyMainLaunchReport,
  thirdPartyLaunchSession,
  type ThirdPartyMainLaunchSnapshot,
} from './third-party-main-loader'
import type { InstalledModule } from './user-module-registry'
import { toThirdPartyModuleView } from './third-party-module-view'
import { test } from 'vitest'

test('third-party-module-view', async () => {
  function main(): void {
    testLaunchReadinessClasses()
    testExpectedToLoadUsesEnablementOverrides()
    testCurrentBlockedStateWinsOverStaleLaunchError()
    testLaunchErrorsAreSanitized()

    console.log('third-party-module-view tests passed')
  }

  function testLaunchReadinessClasses(): void {
    const snapshot: ThirdPartyMainLaunchSnapshot = {
      loaded: new Set(['approved-main']),
      manifestOnly: new Set(['manifest-only']),
      errors: new Map([['broken-main', 'main must export activate(studio), as a named export or its default.']]),
    }

    assert.deepEqual(
      toThirdPartyModuleView(installedModule({ id: 'approved-main', standing: 'approved', main: 'main.cjs' }), snapshot)
        .launch,
      {
        status: 'runs_worker',
        hasMainEntry: true,
        expectedToLoad: true,
        mainLoaded: true,
        rendererEntry: { availability: 'none' },
        message: 'Its worker runs.',
      },
    )
    assert.deepEqual(
      toThirdPartyModuleView(installedModule({ id: 'manifest-only', standing: 'approved' }), snapshot).launch,
      {
        status: 'runs_without_worker',
        hasMainEntry: false,
        expectedToLoad: false,
        mainLoaded: false,
        rendererEntry: { availability: 'none' },
        message: 'It has no worker; nothing runs in the background.',
      },
    )
    assert.deepEqual(
      toThirdPartyModuleView(installedModule({ id: 'unsigned', standing: 'pending', main: 'main.cjs' }), snapshot)
        .launch,
      {
        status: 'awaiting_approval',
        hasMainEntry: true,
        expectedToLoad: false,
        mainLoaded: false,
        rendererEntry: { availability: 'none' },
        message: 'It waits for your approval before it runs.',
      },
    )
    assert.deepEqual(
      toThirdPartyModuleView(installedModule({ id: 'signed', standing: 'pending', main: 'main.cjs' }), snapshot).launch,
      {
        status: 'awaiting_approval',
        hasMainEntry: true,
        expectedToLoad: false,
        mainLoaded: false,
        rendererEntry: { availability: 'none' },
        message: 'It waits for your approval before it runs.',
      },
    )
    assert.deepEqual(
      toThirdPartyModuleView(installedModule({ id: 'invalid', standing: 'invalid', main: 'main.cjs' }), snapshot)
        .launch,
      {
        status: 'blocked_invalid',
        hasMainEntry: true,
        expectedToLoad: false,
        mainLoaded: false,
        rendererEntry: { availability: 'none' },
        message: 'Its signature is invalid, so it will not run.',
      },
    )
    assert.equal(
      toThirdPartyModuleView(
        installedModule({ id: 'tampered', standing: 'invalid', main: 'main.cjs', tampered: true }),
        snapshot,
      ).launch.message,
      'Its files do not match the digests extension.sig signs (tampered), so it will not run.',
    )
    assert.deepEqual(
      toThirdPartyModuleView(installedModule({ id: 'broken-main', standing: 'approved', main: 'main.cjs' }), snapshot)
        .launch,
      {
        status: 'launch_error',
        hasMainEntry: true,
        expectedToLoad: false,
        mainLoaded: false,
        rendererEntry: { availability: 'none' },
        message: 'main must export activate(studio), as a named export or its default.',
      },
    )
  }

  function testExpectedToLoadUsesEnablementOverrides(): void {
    const snapshot: ThirdPartyMainLaunchSnapshot = {
      loaded: new Set(['default-on-disabled']),
      manifestOnly: new Set(),
      errors: new Map(),
    }

    assert.deepEqual(
      toThirdPartyModuleView(
        installedModule({ id: 'default-on-disabled', standing: 'approved', main: 'main.cjs' }),
        snapshot,
        { 'default-on-disabled': false },
      ).launch,
      {
        status: 'runs_worker',
        hasMainEntry: true,
        expectedToLoad: false,
        mainLoaded: true,
        rendererEntry: { availability: 'none' },
        message: 'Its worker is switched off until you switch it on.',
      },
    )
    assert.deepEqual(
      toThirdPartyModuleView(installedModule({ id: 'switched-on', standing: 'approved', main: 'main.cjs' }), snapshot, {
        'switched-on': true,
      }).launch,
      {
        status: 'runs_worker',
        hasMainEntry: true,
        expectedToLoad: true,
        mainLoaded: false,
        rendererEntry: { availability: 'none' },
        message: 'Its worker runs.',
      },
    )
  }

  function testCurrentBlockedStateWinsOverStaleLaunchError(): void {
    const snapshot: ThirdPartyMainLaunchSnapshot = {
      loaded: new Set(),
      manifestOnly: new Set(),
      errors: new Map([['changed-module', 'Previous startup failed.']]),
    }

    assert.deepEqual(
      toThirdPartyModuleView(installedModule({ id: 'changed-module', standing: 'pending', main: 'main.cjs' }), snapshot)
        .launch,
      {
        status: 'awaiting_approval',
        hasMainEntry: true,
        expectedToLoad: false,
        mainLoaded: false,
        rendererEntry: { availability: 'none' },
        message: 'It waits for your approval before it runs.',
      },
    )
  }

  // However a loader or a module words its error, a place on this disk is not
  // passed on: quoted, in a stack frame, after a colon, as a file URL, with
  // either Windows separator, or a UNC share. Words without one pass as written.
  function testLaunchErrorsAreSanitized(): void {
    const leaking = [
      "Cannot find module '/Users/example/.sprintengine/modules/broken-main/main.cjs'",
      'boom\n    at registerMain (/Users/example/modules/broken-main/main.cjs:3:9)',
      'config missing at:/Users/example/.config/broken.json',
      'Failed to load file:///Users/example/modules/broken-main/main.mjs',
      'Cannot read C:/Users/example/modules/broken-main/main.cjs',
      'Cannot read C:\\Users\\example\\modules\\broken-main\\main.cjs',
      'Cannot read \\\\build-box\\share\\main.cjs',
    ]
    for (const message of leaking) {
      recordThirdPartyMainLaunchReport(['broken-main'], {
        loaded: [],
        manifestOnly: [],
        disabled: [],
        sidecars: [],
        errors: [{ id: 'broken-main', message }],
      })
      assert.deepEqual(
        toThirdPartyModuleView(
          installedModule({ id: 'broken-main', standing: 'approved', main: 'main.cjs' }),
          readThirdPartyMainLaunchSnapshot(),
        ).launch,
        {
          status: 'launch_error',
          hasMainEntry: true,
          expectedToLoad: false,
          mainLoaded: false,
          rendererEntry: { availability: 'none' },
          message: 'The extension’s worker failed during startup.',
        },
        message,
      )
    }
    for (const message of [
      'main must export activate(studio), as a named export or its default.',
      'and/or 1/2 failed: see https://example.com/help',
    ]) {
      recordThirdPartyMainLaunchReport(['broken-main'], {
        loaded: [],
        manifestOnly: [],
        disabled: [],
        sidecars: [],
        errors: [{ id: 'broken-main', message }],
      })
      assert.equal(readThirdPartyMainLaunchSnapshot().errors.get('broken-main'), message)
    }
  }

  main()
})

// An installed extension as discovery lists it: the worker tier when it has a
// `main`, the content tier otherwise.
function installedModule(options: {
  id: string
  standing: 'approved' | 'pending' | 'invalid'
  main?: string
  tampered?: boolean
}): InstalledModule {
  const validated = validateExtensionManifest(
    options.main
      ? extensionManifest({ id: options.id, main: options.main })
      : extensionManifest({ id: options.id, tier: 'content', permissions: undefined, main: undefined }),
  )
  assert.ok(validated.ok)
  return {
    key: options.id,
    publisher: 'local',
    manifest: capabilityManifestOf(options.id, 'local', validated.manifest),
    extension: validated.manifest,
    moduleRoot: 'test-root',
    standing:
      options.standing === 'approved'
        ? {
            signature: 'unsigned',
            approval: options.main ? { state: 'approved', fingerprint: 'sha256-test' } : { state: 'not-needed' },
            verifiedFiles: {},
          }
        : {
            signature: options.standing === 'invalid' ? 'invalid' : 'unsigned',
            approval:
              options.standing === 'invalid'
                ? { state: 'unavailable' }
                : { state: 'pending', fingerprint: 'sha256-test', growth: [], reapproval: false },
            ...(options.tampered ? { tampered: true } : {}),
          },
  }
}

test('the view carries the approval, the signature, and what it registered this session', () => {
  const snapshot: ThirdPartyMainLaunchSnapshot = { loaded: new Set(['m']), manifestOnly: new Set(), errors: new Map() }
  const module = installedModule({ id: 'm', standing: 'approved', main: 'dist/main.cjs' })
  const view = toThirdPartyModuleView(
    { ...module, standing: { ...module.standing, signature: 'verified', signer: 'abc' } },
    snapshot,
    {},
    { mcpTools: ['m_search'] },
  )
  assert.deepEqual(view.approval, { state: 'approved', fingerprint: 'sha256-test' })
  assert.equal(view.signature, 'verified')
  assert.equal(view.signer, 'abc')
  assert.deepEqual(view.mcpTools, ['m_search'])
  assert.equal(view.extension.id, 'm')
  assert.equal(view.launch.mainLoaded, true)
  // One waiting for approval names the fingerprint to approve; a first one lists no growth.
  const waiting = installedModule({ id: 'u', standing: 'pending', main: 'dist/main.cjs' })
  assert.deepEqual(toThirdPartyModuleView(waiting, snapshot).approval, { state: 'pending', fingerprint: 'sha256-test' })
})

test('the launch session groups each module’s MCP tools under it', () => {
  const session = thirdPartyLaunchSession(
    { loaded: new Set(['a']), manifestOnly: new Set(), errors: new Map([['b', 'boom']]) },
    [
      { moduleId: 'a', registration: { name: 'a.one' } },
      { moduleId: 'a', registration: { name: 'a.two' } },
    ],
  )
  assert.deepEqual([...session.snapshot.loaded], ['a'])
  assert.equal(session.snapshot.errors.get('b'), 'boom')
  assert.deepEqual(session.mcpTools.get('a'), ['a.one', 'a.two'])
  assert.equal(thirdPartyLaunchSession(session.snapshot, []).mcpTools.size, 0)
})
