import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { test } from 'vitest'

import { THEME_TOKENS } from '../../packages/extension-sdk/src/index'
import { APP_THEMES, LIGHT_SURFACE_THEMES } from './app-theme'
import { EXTENSION_FRAME_THEMES } from './extension-frame-themes.generated'

// The server draws a browser's frame in its theme from a table built from the
// app's stylesheet. The table must be the one the build would write now, and
// hold every token of every built-in theme.

test('the frame themes are the ones the stylesheet gives now', async () => {
  const { buildFrameThemes, renderFrameThemes } = (await import(
    // @ts-expect-error A build script, not part of the typed program.
    '../../scripts/build-extension-frame-themes.mjs'
  )) as { buildFrameThemes(): unknown; renderFrameThemes(themes: unknown): string }
  const written = readFileSync(join(__dirname, 'extension-frame-themes.generated.ts'), 'utf8')
  assert.equal(written, renderFrameThemes(buildFrameThemes()), 'run node scripts/build-extension-frame-themes.mjs')
})

test('every built-in theme has every token, in its own light or dark', () => {
  for (const theme of APP_THEMES) {
    if (!theme.resolved) continue
    const frame = EXTENSION_FRAME_THEMES[theme.resolved]
    assert.ok(frame, theme.resolved)
    assert.deepEqual(Object.keys(frame.tokens).sort(), [...THEME_TOKENS].sort(), theme.resolved)
    assert.equal(frame.colorScheme, LIGHT_SURFACE_THEMES.includes(theme.resolved) ? 'light' : 'dark', theme.resolved)
  }
})
