// extension.json, validated by the SDK the way Studio reads it, for tests to
// hand the fake hosts. Importing it fails the test run when the manifest is
// not one Studio accepts.

import { validateExtensionManifest, type ExtensionManifest } from '@sprintengine/extension-sdk'

import raw from '../extension/extension.json'

const result = validateExtensionManifest(raw, { authoring: true })
if (!result.ok) {
  throw new Error(
    `extension/extension.json is not valid:\n${result.issues.map((issue) => `  ${issue.path}: ${issue.message}`).join('\n')}`,
  )
}

export const manifest: ExtensionManifest = result.manifest
