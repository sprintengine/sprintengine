import assert from 'node:assert/strict'

import { addThirdPartyModuleFromFolder } from './addThirdPartyModuleFromFolder'
import { test } from 'vitest'

test('addThirdPartyModuleFromFolder', async () => {
  async function run(): Promise<void> {
    assert.deepEqual(
      await addThirdPartyModuleFromFolder({}, null),
      { status: 'failed', message: "Can't install extensions in this build." },
      'a window without a folder chooser or a Studio connection reports an unavailable action',
    )

    let installs = 0
    assert.deepEqual(
      await addThirdPartyModuleFromFolder(
        { openDir: async () => null },
        {
          install: async () => {
            installs += 1
            return {
              ok: true,
              moduleId: 'x',
              approval: { state: 'pending', fingerprint: 'sha256-x' },
              strippedLinks: [],
            }
          },
        },
      ),
      { status: 'cancelled' },
      'closing the folder chooser is a quiet cancellation',
    )
    assert.equal(installs, 0, 'cancellation never calls the installer')

    let selected = ''
    assert.deepEqual(
      await addThirdPartyModuleFromFolder(
        { openDir: async () => '/extensions/compass' },
        {
          install: async (folder) => {
            selected = folder
            return {
              ok: true,
              moduleId: 'local.compass',
              approval: { state: 'pending', fingerprint: 'sha256-x' },
              strippedLinks: [],
            }
          },
        },
      ),
      {
        status: 'installed',
        id: 'local.compass',
        approval: { state: 'pending', fingerprint: 'sha256-x' },
        strippedLinks: [],
      },
      'a selected folder is installed through the Studio and says what it waits to have approved',
    )
    assert.equal(selected, '/extensions/compass')

    assert.deepEqual(
      await addThirdPartyModuleFromFolder(
        { openDir: async () => '/extensions/linked' },
        {
          install: async () => ({
            ok: true,
            moduleId: 'local.linked',
            approval: { state: 'pending', fingerprint: 'sha256-x' },
            strippedLinks: ['dist/shared.js', 'node_modules'],
          }),
        },
      ),
      {
        status: 'installed',
        id: 'local.linked',
        approval: { state: 'pending', fingerprint: 'sha256-x' },
        strippedLinks: ['dist/shared.js', 'node_modules'],
      },
      'the symbolic links left out of the copy come back for the install review to name',
    )
    assert.deepEqual(
      await addThirdPartyModuleFromFolder(
        { openDir: async () => '/extensions/older-studio' },
        {
          install: async () =>
            ({ ok: true, moduleId: 'local.older', approval: { state: 'pending', fingerprint: 'sha256-x' } }) as never,
        },
      ),
      {
        status: 'installed',
        id: 'local.older',
        approval: { state: 'pending', fingerprint: 'sha256-x' },
        strippedLinks: [],
      },
      'a Studio that reports no links reads as none stripped',
    )

    assert.deepEqual(
      await addThirdPartyModuleFromFolder(
        { openDir: async () => '/extensions/not-a-module' },
        {
          install: async () => ({
            ok: false,
            message: '',
            issues: [{ path: 'id', message: '"notes" must match its folder "local.other".' }],
          }),
        },
      ),
      { status: 'failed', message: '"notes" must match its folder "local.other".' },
      'manifest validation failures return the Studio’s explanation',
    )
  }

  const suiteRun = run().then(() => console.log('addThirdPartyModuleFromFolder.test.ts: ok'))

  await suiteRun
})
