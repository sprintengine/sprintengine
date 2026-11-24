import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { test } from 'vitest'

import { buildSurfaceModules, COMPONENTS_MODULE } from '../../../../packages/extension-sdk/src/source-modules'
import { EXTENSION_FRAME_CSP } from '../../../shared/extension-frames'
import { EXTENSION_FRAME_THEMES } from '../../../shared/extension-frame-themes.generated'
import { COMPONENTS_RUNTIME_SOURCE } from './components-runtime.generated'
import { buildExtensionFrameDocument } from './frame-document'

// A components panel's frame: the same document, policy and bridge as any
// frame, its JSX compiled for Studio's components module, which loads with it,
// and its bootstrap booting the panel's default export instead of `mount`.

test('the components module the server ships is the one the SDK builds now', async () => {
  const { bundleComponentsRuntime, renderComponentsRuntime } = (await import(
    // @ts-expect-error A build script, not part of the typed program.
    '../../../../scripts/build-components-runtime.mjs'
  )) as { bundleComponentsRuntime(): string; renderComponentsRuntime(code: string): string }
  const written = readFileSync(join(__dirname, 'components-runtime.generated.ts'), 'utf8')
  assert.equal(
    written,
    renderComponentsRuntime(bundleComponentsRuntime()),
    'run node scripts/build-components-runtime.mjs',
  )
})

const files: Record<string, string> = {
  'src/panel.tsx': [
    "import { atom, read, Stack, Text } from '@sprintengine/extension-sdk/components'",
    "import { label } from './label'",
    "const count = atom('count', 0, { persist: 'plugin' })",
    'export default function Panel() {',
    '  return <Stack gap="sm"><Text>{label} {read(count)}</Text></Stack>',
    '}',
  ].join('\n'),
  'src/label.ts': "export const label: string = 'Clicked'",
}
const read = (path: string) => files[path] ?? null

test('a components panel compiles its JSX for the components module, loaded first and only for it', () => {
  const graph = buildSurfaceModules('src/panel.tsx', read, {
    jsx: 'components',
    componentsModule: COMPONENTS_RUNTIME_SOURCE,
  })
  assert.ok(graph.ok)
  assert.deepEqual(
    graph.modules.map((module) => module.path),
    [COMPONENTS_MODULE, 'src/label.ts', 'src/panel.tsx'],
  )
  const panel = graph.modules.at(-1)!.code
  // Both the module and its JSX runtime are the one module, by its token.
  assert.equal(panel.split(`${graph.token}0`).length - 1, 2)
  assert.match(panel, /_jsx\(Stack/)
  // Lines stay where they were.
  assert.equal(panel.split('\n').length, files['src/panel.tsx']!.split('\n').length)
  // A frame that draws itself cannot import it.
  const html = buildSurfaceModules('src/panel.tsx', read)
  assert.equal(html.ok, false)
  if (!html.ok) assert.match(html.problem.message, /only a components panel/)
  // A bare package is still refused.
  const bare = buildSurfaceModules('src/bare.tsx', (path) => (path === 'src/bare.tsx' ? "import 'react'" : null), {
    jsx: 'components',
  })
  assert.equal(bare.ok, false)
})

test('its document has the frames’ policy, so the module reaches no network, and boots the default export', () => {
  const graph = buildSurfaceModules('src/panel.tsx', read, {
    jsx: 'components',
    componentsModule: COMPONENTS_RUNTIME_SOURCE,
  })
  assert.ok(graph.ok)
  const html = buildExtensionFrameDocument({
    surface: { point: 'panels', id: 'counter' },
    entryPath: 'src/panel.tsx',
    modules: graph.modules,
    token: graph.token,
    theme: EXTENSION_FRAME_THEMES.light!,
    components: true,
  })
  assert.ok(html.includes(EXTENSION_FRAME_CSP))
  assert.match(EXTENSION_FRAME_CSP, /connect-src 'none'/)
  assert.match(EXTENSION_FRAME_CSP, /default-src 'none'/)
  assert.match(html, /"components":true/)
  assert.match(html, /bootComponentsPanel\(componentsBridge/)
  assert.ok(html.includes('bootComponentsPanel'), 'the runtime travels inside the document')
})
