// An installed-extension folder for tests: an extension.json, the files it
// names, and, when asked, the extension.sig `sprintengine-extension sign`
// would write. One helper so every suite builds extensions the way the SDK
// does, rather than each keeping its own idea of the format.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { EXTENSION_MANIFEST_SINCE } from '../packages/extension-sdk/src/extension-manifest'
import {
  computeModuleFileDigestsSync,
  generateModuleSigningKeyPair,
  signExtensionFiles,
  type ModuleSigningKeyPair,
} from '../packages/extension-sdk/src/signing'

/** A worker that registers nothing, as CommonJS. */
export const EMPTY_WORKER_SOURCE = 'exports.activate = () => {}\n'

/** A ui entry that draws one line, as an ES module. */
export const HELLO_MOUNT_SOURCE = "export function mount(root) { root.textContent = 'Hello' }\n"

/** A valid extension.json, worker tier by default; `overrides` replace top-level fields. */
export function extensionManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: 'demo',
    version: '1.0.0',
    engines: { studio: `>=${EXTENSION_MANIFEST_SINCE}` },
    tier: 'worker',
    name: 'Demo',
    description: 'A demo.',
    permissions: ['storage'],
    main: 'dist/main.cjs',
    ...overrides,
  }
}

export type ExtensionFolderOptions = {
  /** extension.json's content; a string is written as it is. Default: `extensionManifest()`. */
  manifest?: Record<string, unknown> | string
  /** Other files by relative path. Default: the worker the default manifest names. */
  files?: Record<string, string>
  /** Sign the folder as it ends up, writing extension.sig. */
  signer?: ModuleSigningKeyPair
}

/** Write an extension folder at `dir` (created), and return it. */
export function writeExtensionFolder(dir: string, options: ExtensionFolderOptions = {}): string {
  mkdirSync(dir, { recursive: true })
  const manifest = options.manifest ?? extensionManifest()
  writeFileSync(join(dir, 'extension.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  for (const [path, content] of Object.entries(options.files ?? { 'dist/main.cjs': EMPTY_WORKER_SOURCE })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  if (options.signer) signExtensionFolder(dir, options.signer)
  return dir
}

/** Write extension.sig over the folder as it is now. */
export function signExtensionFolder(dir: string, signer: ModuleSigningKeyPair): void {
  const scan = computeModuleFileDigestsSync(dir, { walk: 'pack' })
  if (!scan.ok) throw new Error(`cannot sign ${dir}: ${scan.issues.map((issue) => issue.message).join('; ')}`)
  writeFileSync(join(dir, 'extension.sig'), JSON.stringify(signExtensionFiles(scan.files, signer.privateKeyPem)))
}

/** A fresh signing key and its fingerprint, as trusted-publishers.json would list it. */
export function newExtensionSigner(): ModuleSigningKeyPair {
  return generateModuleSigningKeyPair()
}
