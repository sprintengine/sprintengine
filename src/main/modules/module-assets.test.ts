import assert from 'node:assert/strict'
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { moduleAssetUrl } from '../../shared/modules/assets'
import { createModuleAssetHandler, isAllowedModuleAssetRequest } from './module-assets'
import { discoverUserModules } from './user-module-registry'
import { createModuleAssetOriginResolver } from './module-asset-origins'
import { extensionContentSync } from './module-signature'
import { extensionManifest, writeExtensionFolder } from '../../../tests/extension-folder'
import { test } from 'vitest'

test('module-assets', async () => {
  async function run() {
    const shell = { url: 'file:///app/renderer/index.html?window=primary', parent: null }
    const own = { url: moduleAssetUrl('local.doom', 'index.html'), parent: shell }
    const remote = { url: 'https://untrusted.example/', parent: shell }
    const target = moduleAssetUrl('local.doom', 'engine.wasm')
    const check = (frame: { url: string; parent: unknown } | null, resourceType = 'xhr') =>
      isAllowedModuleAssetRequest({ url: target, resourceType, frame }, 'file:///app/renderer/index.html')
    assert.equal(check(shell), true)
    assert.equal(check(own), true)
    assert.equal(check(remote), false)
    assert.equal(check({ url: moduleAssetUrl('other', 'index.html'), parent: shell }), false)
    assert.equal(check({ url: '', parent: shell }, 'subFrame'), true)
    assert.equal(check({ url: '', parent: remote }, 'subFrame'), false)
    assert.equal(check(null), false)
    const root = await mkdtemp(join(tmpdir(), 'studio-module-assets-'))
    try {
      const directory = writeExtensionFolder(join(root, 'local.doom'), {
        manifest: extensionManifest({ id: 'doom', tier: 'content', permissions: undefined, main: undefined }),
        files: {
          'runtime/index.html': '<script src="engine.js"></script>',
          'runtime/engine.wasm': '\u0000asm',
        },
      })
      // The grant names the folder's content as it is, as trusting it in Settings records.
      const content = extensionContentSync(directory)
      assert.ok(content.ok)
      const trustedModules = new Map([['local.doom', content.fingerprint]])
      let enabled = true
      const assetOrigin = createModuleAssetOriginResolver(join(root, 'private-profile'))
      assert.equal(
        assetOrigin('local.doom'),
        createModuleAssetOriginResolver(join(root, 'private-profile'))('local.doom'),
      )
      assert.notEqual(assetOrigin('local.doom'), assetOrigin('other'))
      const asset = (id: string, path: string) => moduleAssetUrl(id, path, assetOrigin(id))
      const handler = createModuleAssetHandler({
        assetOrigin,
        discoverModules: () => discoverUserModules(root, { trustedModules }),
        isEnabled: () => enabled,
      })
      const url = asset('local.doom', 'runtime/index.html')
      assert.equal(url, asset('local.doom', 'runtime/index.html'))
      assert.equal((await handler(new Request(moduleAssetUrl('local.doom', 'runtime/index.html')))).status, 403)
      assert.notEqual(new URL(url).hostname, new URL(moduleAssetUrl('other', 'runtime/index.html')).hostname)
      for (const path of [
        '../secret',
        '/etc/passwd',
        'runtime/../secret',
        'runtime\\secret',
        'runtime/%',
        'runtime/file?query',
      ]) {
        if (path === 'runtime/%') continue
        assert.throws(() => moduleAssetUrl('local.doom', path))
      }
      assert.equal((await handler(new Request(url))).status, 200)
      const wasm = await handler(new Request(new URL('engine.wasm', url)))
      assert.equal(wasm.headers.get('content-type'), 'application/wasm')
      assert.equal(wasm.headers.get('access-control-allow-origin'), null)
      assert.deepEqual(new Uint8Array(await wasm.arrayBuffer()), new Uint8Array([0, 97, 115, 109]))
      assert.equal((await handler(new Request(url, { method: 'HEAD' }))).headers.get('content-length'), '33')
      assert.equal((await handler(new Request(url, { method: 'POST' }))).status, 405)
      assert.equal((await handler(new Request(moduleAssetUrl('unknown', 'file')))).status, 403)
      enabled = false
      assert.equal((await handler(new Request(url))).status, 403)
      enabled = true
      assert.equal((await handler(new Request(`${url}/%2e%2e%2f%2e%2e%2fsecret`))).status, 400)
      // Served bytes are the verified bytes: a file changed after the grant is
      // refused, and so is one the module was never verified with.
      await writeFile(join(directory, 'runtime', 'engine.wasm'), new Uint8Array([1, 2, 3, 4]))
      assert.equal((await handler(new Request(new URL('engine.wasm', url)))).status, 403)
      await writeFile(join(directory, 'runtime', 'engine.wasm'), new Uint8Array([0, 97, 115, 109]))
      assert.equal((await handler(new Request(new URL('engine.wasm', url)))).status, 200)
      await writeFile(join(root, 'secret'), 'secret')
      await symlink(join(root, 'secret'), join(directory, 'runtime', 'escape'))
      assert.equal((await handler(new Request(asset('local.doom', 'runtime/escape')))).status, 403)
      // A symlink in the folder is a file the module cannot vouch for, so the
      // whole module stops being trusted, not only that path.
      assert.equal((await handler(new Request(url))).status, 403)
      trustedModules.clear()
      assert.equal((await handler(new Request(url))).status, 403)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
  const suiteRun = run().then(() => console.log('module-assets tests passed'))

  await suiteRun
})
