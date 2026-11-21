#!/usr/bin/env node
// Check an extension project the way SprintEngine Studio will check it.
//
//   node scripts/validate.mjs [--project <dir>]
//
// - extension/extension.json through the SDK's own validator, as an author's
//   tools hold it: unknown fields, unsafe paths, a contribution above the
//   declared tier and an `engines.studio` older than the fields it uses are
//   all refused;
// - an id Studio keeps for its own extensions (`studio-…`, `sprintengine-…`);
// - every file extension.json names, in extension/ (run `npm run build` first);
// - every file in extension/ is one an install can carry (no symbolic links,
//   no node_modules, no key files);
// - no key material anywhere in the project;
// - and, when extension/extension.sig exists, `sprintengine-extension verify`,
//   the exact check Studio runs on a signed extension.
//
// Exit 1 on anything Studio would refuse.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'

import {
  declaredFiles,
  extensionDirOf,
  keyFilesIn,
  loadSdk,
  printIssues,
  projectDirFrom,
  readManifest,
} from './module-tools.mjs'

const projectDir = projectDirFrom(process.argv.slice(2))
const extensionDir = extensionDirOf(projectDir)
const { sdk, signing, cliPath } = await loadSdk(projectDir)
const manifest = readManifest(sdk, projectDir)

const errors = []

if (sdk.isReservedExtensionId(manifest.id)) {
  errors.push(`id "${manifest.id}" is kept for Studio’s own extensions (studio-…, sprintengine-…); choose another.`)
}

for (const { path, file } of declaredFiles(sdk, manifest)) {
  if (!existsSync(join(extensionDir, file)))
    errors.push(`${path}: extension/${file} does not exist. Run \`npm run build\`.`)
}

const walk = signing.computeModuleFileDigestsSync(extensionDir, { walk: 'installed' })
if (!walk.ok) {
  console.error('extension/ holds files an install cannot carry:')
  printIssues(walk.issues)
  errors.push('extension/ must hold regular files only (see above).')
}

const keyFiles = keyFilesIn(projectDir)
if (keyFiles.length > 0) {
  errors.push(
    `key material in the project (${keyFiles.join(', ')}). Keep signing keys in ~/.sprintengine/keys, never in a repository.`,
  )
}

const signed = existsSync(join(extensionDir, 'extension.sig'))
if (signed && errors.length === 0) {
  const verified = spawnSync(process.execPath, [cliPath, 'verify', relative(projectDir, extensionDir)], {
    cwd: projectDir,
    stdio: 'inherit',
  })
  if (verified.status !== 0) {
    errors.push(
      'extension/extension.sig no longer matches extension/ (see above). Sign it again, or delete it to ship unsigned.',
    )
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`error: ${error}`)
  process.exit(1)
}
console.log(
  `${manifest.id}: valid (${manifest.tier} tier, ${manifest.permissions.length} permission(s), ${signed ? 'signed' : 'unsigned'}).`,
)
