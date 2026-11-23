import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

import { defaultUserModuleRoot } from './modules/user-module-registry'

// The extensions folder. On a packaged install nothing tells a user where
// installed extensions are kept, and the folder only exists once something has
// been installed. This ensures it exists on startup and seeds it with a README
// so a user (or an SDK author shipping a folder) can discover the contract
// without reading source. Best-effort: a failure here must never block app
// startup.

const EXTENSION_README_FILENAME = 'README.md'

export const MODULE_FOLDER_README = `# SprintEngine extensions

Studio keeps the extensions it installed here, one folder each, named by
its install key: the publisher Studio derived from where it came from
(\`local\` for a folder you installed), then its id.

## Layout

\`\`\`
~/.sprintengine/extensions/
  local.<extension-id>/
    extension.json  # required — its id must match the folder's
    extension.sig   # optional signature, written by sprintengine-extension sign
    dist/main.cjs   # the worker (\`main\`), for a worker-tier extension
    dist/panel.js   # the \`entry\` of a panel, door or settings section
\`\`\`

## Getting started

Author extensions against the published SDK:

\`\`\`
npm install --save-dev @sprintengine/extension-sdk
\`\`\`

An \`extension.json\` declares what the extension adds (panels, doors,
settings sections, commands, menus, top bar items, agent tools, and the
skills, MCP servers and model providers it hands agents and chats) and the
most authority it needs. A surface's \`entry\` exports \`mount(root, studio)\`; the
worker exports \`activate(studio)\`. Validate, pack and sign with the bundled
CLI:

\`\`\`
npx sprintengine-extension pack ./my-extension
npx sprintengine-extension sign ./my-extension --key ./signing.pem
\`\`\`

Install an extension folder from **Settings → Extensions**, which copies it
here; there you review the access each one requests and grant trust before
its code runs.
`

export type EnsureExtensionFoldersOptions = {
  moduleRoot?: string
}

export type EnsureExtensionFoldersResult = {
  moduleRoot: string
  errors: string[]
}

/**
 * Create the extensions folder if absent and seed it with a README describing
 * the contract. Idempotent: an existing folder is left in place and an
 * existing README is never overwritten (a user may have edited or removed
 * it). Returns the resolved root and any non-fatal errors.
 */
export function ensureExtensionFolders(options: EnsureExtensionFoldersOptions = {}): EnsureExtensionFoldersResult {
  const moduleRoot = options.moduleRoot ?? defaultUserModuleRoot()
  const errors: string[] = []
  seedFolder(moduleRoot, MODULE_FOLDER_README, errors)
  return { moduleRoot, errors }
}

function seedFolder(root: string, readme: string, errors: string[]): void {
  try {
    mkdirSync(root, { recursive: true })
  } catch (err) {
    errors.push(`Could not create "${root}": ${formatError(err)}`)
    return
  }
  const readmePath = join(root, EXTENSION_README_FILENAME)
  if (existsSync(readmePath)) return
  try {
    writeFileSync(readmePath, readme, 'utf8')
  } catch (err) {
    errors.push(`Could not write "${readmePath}": ${formatError(err)}`)
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
