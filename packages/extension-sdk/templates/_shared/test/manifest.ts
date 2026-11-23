// extension.json, validated by the SDK the way Studio reads it, for tests to
// hand the fake hosts. Importing it fails the test run when the manifest is
// not one Studio accepts. Read from disk rather than imported: Node imports
// JSON only with an import attribute, which a type-stripped test does not get.

import { readFileSync } from 'node:fs'

import { validateExtensionManifest, type ExtensionManifest } from '@sprintengine/extension-sdk'

const raw: unknown = JSON.parse(readFileSync(new URL('../extension/extension.json', import.meta.url), 'utf8'))
const result = validateExtensionManifest(raw, { authoring: true })
if (!result.ok) {
  throw new Error(
    `extension/extension.json is not valid:\n${result.issues.map((issue) => `  ${issue.path}: ${issue.message}`).join('\n')}`,
  )
}

export const manifest: ExtensionManifest = result.manifest
