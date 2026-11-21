// Helpers the extension dev-loop scripts share (build-ui.mjs, validate.mjs,
// dev-install.mjs).
//
// Everything here reads the project's OWN installed @sprintengine/extension-sdk,
// never a copy of its rules: the validator, the file walk and the signing CLI
// are the code Studio itself runs, so a project these scripts accept is one
// Studio accepts.

import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SDK_PACKAGE = '@sprintengine/extension-sdk'

/** `--project <dir>` (default: the current folder, which is what `npm run` uses). */
export function projectDirFrom(argv) {
  const index = argv.indexOf('--project')
  return resolve(index === -1 ? process.cwd() : (argv[index + 1] ?? '.'))
}

export function flagValue(argv, name) {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * The installable folder: extension.json and everything it names. All of it
 * is what Studio installs and what a signature covers; everything outside it
 * is source.
 */
export function extensionDirOf(projectDir) {
  return join(projectDir, 'extension')
}

/** The project's installed SDK: its root entry, its signing entry, and its CLI. */
export async function loadSdk(projectDir) {
  const require = createRequire(join(projectDir, 'package.json'))
  let indexPath
  try {
    indexPath = require.resolve(SDK_PACKAGE)
  } catch {
    fail(`${SDK_PACKAGE} is not installed in ${projectDir}. Run \`npm install\` first.`)
  }
  const sdk = await import(pathToFileURL(indexPath).href)
  const signing = await import(pathToFileURL(require.resolve(`${SDK_PACKAGE}/signing`)).href)
  return { sdk, signing, cliPath: join(dirname(indexPath), 'cli.js') }
}

/**
 * extension.json, read and validated the way an author's tools hold it
 * (`engines.studio` must cover every field it uses). Exits with the issues
 * when it is not one Studio accepts.
 */
export function readManifest(sdk, projectDir) {
  const path = join(extensionDirOf(projectDir), 'extension.json')
  let raw
  try {
    raw = readJson(path)
  } catch (error) {
    fail(`${relative(projectDir, path)} could not be read: ${error instanceof Error ? error.message : error}`)
  }
  const result = sdk.validateExtensionManifest(raw, { authoring: true })
  if (!result.ok) fail(`${relative(projectDir, path)} is not one Studio accepts:`, result.issues)
  return result.manifest
}

/** Every file extension.json names: the worker, each surface's entry, the images. */
export function declaredFiles(sdk, manifest) {
  const files = []
  if (manifest.main) files.push({ path: 'main', file: manifest.main })
  for (const point of sdk.EXTENSION_SURFACE_POINTS) {
    manifest.contributes[point].forEach((surface, index) =>
      files.push({ path: `contributes.${point}[${index}].entry`, file: surface.entry }),
    )
  }
  if (manifest.icon) files.push({ path: 'icon', file: manifest.icon })
  if (manifest.cover) files.push({ path: 'cover', file: manifest.cover })
  for (const [index, file] of (manifest.screenshots ?? []).entries())
    files.push({ path: `screenshots[${index}]`, file })
  return files
}

/** Signing keys anywhere in the project, node_modules and .git aside. */
export function keyFilesIn(projectDir) {
  const found = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.name.endsWith('.key') || entry.name.endsWith('.pem')) found.push(relative(projectDir, path))
    }
  }
  visit(projectDir)
  return found
}

export function printIssues(issues) {
  for (const issue of issues ?? []) {
    console.error(`  - ${issue.path === '' ? 'extension.json' : issue.path}: ${issue.message}`)
  }
}

export function fail(message, issues) {
  console.error(message)
  printIssues(issues)
  process.exit(1)
}
