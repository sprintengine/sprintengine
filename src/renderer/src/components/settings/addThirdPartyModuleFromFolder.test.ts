import assert from 'node:assert/strict'

import { addThirdPartyModuleFromFolder } from './addThirdPartyModuleFromFolder'
import { test } from 'vitest'

test('addThirdPartyModuleFromFolder', async () => {
  async function run(): Promise<void> {
    assert.deepEqual(
      await addThirdPartyModuleFromFolder({}, null),
      { status: 'failed', message: 'Installing extension modules is unavailable in this build.' },
      'a window without a folder chooser or a Studio connection reports an unavailable action',
    )

    let installs = 0
    assert.deepEqual(
      await addThirdPartyModuleFromFolder(
        { openDir: async () => null },
        {
          install: async () => {
            installs += 1
            return { ok: true, moduleId: 'x', trust: 'unsigned' }
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
            return { ok: true, moduleId: 'acme.compass', trust: 'unsigned' }
          },
        },
      ),
      { status: 'installed', id: 'acme.compass', trust: 'unsigned' },
      'a selected folder is installed through the Studio and keeps its trust classification',
    )
    assert.equal(selected, '/extensions/compass')

    assert.deepEqual(
      await addThirdPartyModuleFromFolder(
        { openDir: async () => '/extensions/not-a-module' },
        {
          install: async () => ({
            ok: false,
            message: '',
            issues: [{ path: 'manifest.json', message: 'No valid module manifest was found.' }],
          }),
        },
      ),
      { status: 'failed', message: 'No valid module manifest was found.' },
      'manifest validation failures return the Studio’s explanation',
    )
  }

  const suiteRun = run().then(() => console.log('addThirdPartyModuleFromFolder.test.ts: ok'))

  await suiteRun
})
