import assert from 'node:assert/strict'

import { validateExtensionManifest } from '../../../packages/extension-sdk/src/extension-manifest'
import { extensionManifest } from '../../../tests/extension-folder'
import { capabilityManifestOf } from '../../shared/modules/third-party-manifest'
import type { WorkerStatus } from '../../server/extensions/workers/worker-manager'
import type { InstalledModule } from './user-module-registry'
import { toThirdPartyModuleView, type ExtensionRunView } from './third-party-module-view'
import { test } from 'vitest'

/** What a server run did with its extensions, as the view reads it. */
function runView(options: {
  attached?: string[]
  errors?: Record<string, string>
  workers?: Record<string, WorkerStatus>
  tools?: Record<string, string[]>
}): ExtensionRunView {
  return {
    attached: (id) => options.attached?.includes(id) ?? false,
    worker: (id) => options.workers?.[id] ?? (options.attached?.includes(id) ? { state: 'idle' } : null),
    loadError: (id) => options.errors?.[id],
    mcpTools: (id) => options.tools?.[id] ?? [],
  }
}

test('third-party-module-view', async () => {
  function main(): void {
    testLaunchReadinessClasses()
    testExpectedToLoadUsesEnablementOverrides()
    testCurrentBlockedStateWinsOverStaleLaunchError()
    testLaunchErrorsAreSanitized()

    console.log('third-party-module-view tests passed')
  }

  function testLaunchReadinessClasses(): void {
    const snapshot = runView({
      attached: ['approved-main'],
      workers: { 'approved-main': { state: 'running' } },
      errors: { 'broken-main': 'main must export activate(studio), as a named export or its default.' },
    })

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
    const snapshot = runView({ attached: ['default-on-disabled'] })

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
        message: 'Its worker starts when something uses it.',
      },
    )
  }

  function testCurrentBlockedStateWinsOverStaleLaunchError(): void {
    const snapshot = runView({ errors: { 'changed-module': 'Previous startup failed.' } })

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
      assert.deepEqual(
        toThirdPartyModuleView(
          installedModule({ id: 'broken-main', standing: 'approved', main: 'main.cjs' }),
          runView({ errors: { 'broken-main': message } }),
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
      assert.equal(
        toThirdPartyModuleView(
          installedModule({ id: 'broken-main', standing: 'approved', main: 'main.cjs' }),
          runView({ errors: { 'broken-main': message } }),
        ).launch.message,
        message,
      )
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

test('the view carries the approval, the signature, and the tools it serves', () => {
  const snapshot = runView({ attached: ['m'], tools: { m: ['m_search'] } })
  const module = installedModule({ id: 'm', standing: 'approved', main: 'dist/main.cjs' })
  const view = toThirdPartyModuleView(
    { ...module, standing: { ...module.standing, signature: 'verified', signer: 'abc' } },
    snapshot,
    {},
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

test('a worker that crashed past its restarts reads as failed, with why', () => {
  const module = installedModule({ id: 'm', standing: 'approved', main: 'dist/main.cjs' })
  const message = 'Extension "m"\'s worker stopped after it crashed 4 times; it exited unexpectedly (SIGKILL).'
  assert.deepEqual(
    toThirdPartyModuleView(module, runView({ attached: ['m'], workers: { m: { state: 'errored', message } } })).launch,
    {
      status: 'launch_error',
      hasMainEntry: true,
      expectedToLoad: false,
      mainLoaded: true,
      rendererEntry: { availability: 'none' },
      message,
    },
  )
})

test('a worker waiting for a place says why', () => {
  const module = installedModule({ id: 'm', standing: 'approved', main: 'dist/main.cjs' })
  const waiting = 'Waiting to start: 16 extensions already run in the background.'
  const launch = toThirdPartyModuleView(
    module,
    runView({ attached: ['m'], workers: { m: { state: 'waiting', message: waiting } } }),
  ).launch
  assert.equal(launch.status, 'runs_worker')
  assert.equal(launch.waiting, waiting)
})
