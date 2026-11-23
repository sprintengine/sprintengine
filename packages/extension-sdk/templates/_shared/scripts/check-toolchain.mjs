#!/usr/bin/env node
// Is this machine, and this project, ready to work on a SprintEngine Studio
// extension? Run it before anything else:
//
//   node scripts/check-toolchain.mjs [--project <dir>]
//
// Prints one line per check and what to do about each failure. Exit 1 when
// something blocks the dev loop; notes alone exit 0.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
const projectIndex = argv.indexOf('--project')
const projectDir = resolve(projectIndex === -1 ? process.cwd() : (argv[projectIndex + 1] ?? '.'))

let blocked = false
const ok = (message) => console.log(`ok     ${message}`)
const note = (message) => console.log(`note   ${message}`)
const bad = (message) => {
  blocked = true
  console.log(`FAIL   ${message}`)
}

const version = (command, args = ['--version']) => {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: process.platform === 'win32' })
  return result.status === 0 ? result.stdout.trim().split('\n')[0] : null
}

// The SDK and its CLI need Node 22.15 or newer: the first with the module
// hooks and type stripping that load the extension's TypeScript as written.
const [major, minor] = process.versions.node.split('.').map(Number)
if (major > 23 || (major === 23 && minor >= 5) || (major === 22 && minor >= 15)) ok(`node ${process.versions.node}`)
else bad(`node ${process.versions.node} is too old: install Node 22.15 or newer (https://nodejs.org).`)

const npm = version('npm')
if (npm) ok(`npm ${npm}`)
else bad('npm is not on PATH; it ships with Node.')

const git = version('git')
if (git) ok(git)
else note('git is not on PATH; you need it to publish from a GitHub repository.')

// ── The project ──────────────────────────────────────────────────────────────

const packagePath = join(projectDir, 'package.json')
if (!existsSync(packagePath)) {
  note(`${projectDir} has no package.json; run this from an extension project for the project checks.`)
} else {
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
  const wanted =
    pkg.devDependencies?.['@sprintengine/extension-sdk'] ?? pkg.dependencies?.['@sprintengine/extension-sdk']
  if (!wanted) bad('package.json does not depend on @sprintengine/extension-sdk.')
  else ok(`depends on @sprintengine/extension-sdk ${wanted}`)

  if (!existsSync(join(projectDir, 'node_modules'))) {
    bad('node_modules is missing: run `npm install`.')
  } else {
    const require = createRequire(packagePath)
    try {
      const indexPath = require.resolve('@sprintengine/extension-sdk')
      const sdk = await import(pathToFileURL(indexPath).href)
      const installed = JSON.parse(readFileSync(join(dirname(indexPath), '..', 'package.json'), 'utf8')).version
      ok(
        `@sprintengine/extension-sdk ${installed} installed (extension.json from Studio ${sdk.EXTENSION_MANIFEST_SINCE})`,
      )
      const manifestPath = join(projectDir, 'extension', 'extension.json')
      if (!existsSync(manifestPath)) {
        bad('extension/extension.json is missing: it is what Studio installs.')
      } else {
        const result = sdk.validateExtensionManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), {
          authoring: true,
        })
        if (result.ok)
          ok(
            `extension/extension.json is valid (${result.manifest.tier} tier, Studio ${result.manifest.engines.studio})`,
          )
        else bad(`extension/extension.json is not valid; run \`npm run validate\` for the details.`)
      }
    } catch {
      bad('@sprintengine/extension-sdk is not installed: run `npm install`.')
    }
    // Only the type-checker: nothing is built, Studio loads the source as written.
    try {
      require.resolve('typescript/package.json')
      ok('typescript installed')
    } catch {
      bad('typescript is not installed: run `npm install`.')
    }
  }
}

// ── Where Studio looks ───────────────────────────────────────────────────────

const extensionsRoot = process.env.SPRINTENGINE_USER_EXTENSION_ROOT || join(homedir(), '.sprintengine', 'extensions')
if (existsSync(extensionsRoot)) ok(`Studio's extensions folder: ${extensionsRoot}`)
else note(`${extensionsRoot} does not exist yet; Studio creates it on first launch.`)

const keysDir = join(homedir(), '.sprintengine', 'keys')
if (existsSync(keysDir)) ok(`signing keys folder: ${keysDir}`)
else note(`no ${keysDir} yet; \`npm run keygen\` makes a key there when you want to sign.`)

process.exit(blocked ? 1 : 0)
