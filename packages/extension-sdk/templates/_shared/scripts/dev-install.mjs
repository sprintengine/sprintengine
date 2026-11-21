#!/usr/bin/env node
// Install the built extension into SprintEngine Studio on this machine.
//
//   node scripts/dev-install.mjs [--project <dir>] [--key <private-key.pem>] [--no-sign]
//
// Run it after `npm run build` (`npm run dev:install` does both). It:
//
// 1. validates extension/extension.json with the SDK's validator and checks
//    every file it names was built;
// 2. copies extension/ into $SPRINTENGINE_USER_EXTENSION_ROOT (default
//    ~/.sprintengine/extensions)/local.<id>, the folder a folder install
//    lives in, replacing the copy that was there. Symbolic links,
//    node_modules, .git and key files are never copied;
// 3. signs the installed copy when a key is at hand (--key,
//    $SPRINTENGINE_SIGNING_KEY, or ~/.sprintengine/keys/<id>.key), writing its
//    extension.sig. Studio trusts an extension signed by a publisher key the
//    person trusts. With no key it installs unsigned, and Studio waits for the
//    person to trust it in Settings → Extensions.
//
// The project's own extension/ is never written: a signature for publishing is
// `npx sprintengine-extension sign extension --key <file>`.

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'

import {
  declaredFiles,
  extensionDirOf,
  fail,
  flagValue,
  loadSdk,
  projectDirFrom,
  readManifest,
} from './module-tools.mjs'

const argv = process.argv.slice(2)
const projectDir = projectDirFrom(argv)
const extensionDir = extensionDirOf(projectDir)
const { sdk, signing, cliPath } = await loadSdk(projectDir)

// ── 1. Validate ──────────────────────────────────────────────────────────────

const manifest = readManifest(sdk, projectDir)
if (sdk.isReservedExtensionId(manifest.id)) {
  fail(`id "${manifest.id}" is kept for Studio’s own extensions (studio-…, sprintengine-…); choose another.`)
}
for (const { path, file } of declaredFiles(sdk, manifest)) {
  if (!existsSync(join(extensionDir, file)))
    fail(`${path}: extension/${file} does not exist. Run \`npm run build\` first.`)
}

// ── 2. Copy ──────────────────────────────────────────────────────────────────

const root = process.env.SPRINTENGINE_USER_EXTENSION_ROOT || join(homedir(), '.sprintengine', 'extensions')
const installKey = sdk.extensionInstallKey(sdk.LOCAL_EXTENSION_PUBLISHER, manifest.id)
const dest = join(root, installKey)
const staging = join(root, `.${installKey}.installing-${process.pid}`)
mkdirSync(root, { recursive: true })
rmSync(staging, { recursive: true, force: true })

const skipped = []
cpSync(extensionDir, staging, {
  recursive: true,
  filter: (source) => {
    const path = relative(extensionDir, source).split('\\').join('/')
    if (path === '') return true
    if (lstatSync(source).isSymbolicLink()) {
      skipped.push(`${path} (a symbolic link)`)
      return false
    }
    if (sdk.isPackExcludedPath(path)) {
      skipped.push(path)
      return false
    }
    return true
  },
})
for (const path of skipped) console.warn(`Skipped ${path}: never installed.`)

const discard = (message, issues) => {
  rmSync(staging, { recursive: true, force: true })
  fail(message, issues)
}
const walk = signing.computeModuleFileDigestsSync(staging, { walk: 'installed' })
if (!walk.ok) discard('The copy holds files an install cannot carry:', walk.issues)

// ── 3. Sign ──────────────────────────────────────────────────────────────────

const defaultKey = join(homedir(), '.sprintengine', 'keys', `${manifest.id}.key`)
const keyPath = argv.includes('--no-sign')
  ? undefined
  : (flagValue(argv, '--key') ??
    (process.env.SPRINTENGINE_SIGNING_KEY || undefined) ??
    (existsSync(defaultKey) ? defaultKey : undefined))

const signaturePath = join(staging, 'extension.sig')
const run = (args) => spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' })
if (keyPath !== undefined) {
  if (!existsSync(keyPath)) discard(`Signing key not found: ${keyPath}`)
  rmSync(signaturePath, { force: true })
  const signed = run(['sign', staging, '--key', keyPath])
  if (signed.status !== 0) discard(`Signing failed:\n${signed.stderr}`)
} else if (existsSync(signaturePath) && run(['verify', staging]).status !== 0) {
  // A signature over other files reads as tampered, which Studio refuses
  // outright; unsigned, the person can at least trust it by hand.
  console.warn(
    'warning: extension.sig does not match this build and there is no key to sign it again; installing unsigned.',
  )
  rmSync(signaturePath, { force: true })
}

// ── Swap the copy in ─────────────────────────────────────────────────────────

rmSync(dest, { recursive: true, force: true })
renameSync(staging, dest)

const state = existsSync(join(dest, 'extension.sig')) ? 'signed' : 'unsigned'
console.log(
  `Installed ${manifest.id} ${manifest.version} (${state}, ${Object.keys(walk.files).length} file(s)) at ${dest}`,
)
console.log('')
console.log(
  state === 'signed'
    ? 'Studio trusts it if you trust the key that signed it; otherwise trust it in Settings → Extensions.'
    : `Next, in SprintEngine Studio: Settings → Extensions → ${manifest.name} → trust it. Each new build asks again.`,
)
