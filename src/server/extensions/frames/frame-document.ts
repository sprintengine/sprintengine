// The one document a panel, door or settings section is drawn from, built by
// the Studio server for every client: the frame's policy, the theme's tokens
// and Studio's small kit stylesheet, then the bootstrap that builds `studio`
// and loads the extension's entry (frame-bootstrap.ts).
//
// The document is content-addressed: its hash is sha256 of its bytes, so a
// browser loads it from `/ext-frame/<hash>` and a desktop window stages it
// under the same name, and any change (a new version, another theme) is
// another document.

import { createHash } from 'node:crypto'

import { EXTENSION_FRAME_CSP, safeTokenValue, type ExtensionFrameTheme } from '../../../shared/extension-frames'
import { FRAME_ROOT_ID, FRAME_TOKENS_ID, frameBootstrapScript } from './frame-bootstrap'

/**
 * Studio's kit: the frame's ground and type, and a few classes that look like
 * the app's own controls (`se-button`, `se-input`, `se-list`, `se-list-row`,
 * `se-heading`, `se-muted`), drawn from the theme's tokens.
 */
export const EXTENSION_FRAME_KIT_CSS = `
:where(html.light){color-scheme:light}
:where(html.dark){color-scheme:dark}
html[data-se-waiting] body{visibility:hidden}
html,body{margin:0;height:100%}
body{background:var(--bg-surface);color:var(--text-default);font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
#${FRAME_ROOT_ID}{height:100%;overflow:auto;box-sizing:border-box}
.se-heading{margin:0 0 8px;font-size:15px;font-weight:600;color:var(--text-strong)}
.se-muted{color:var(--text-muted)}
.se-failed{margin:16px;color:var(--tone-error)}
.se-button{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--border-default);border-radius:6px;background:var(--bg-surface-raised);color:var(--text-strong);font:inherit;cursor:pointer}
.se-button:hover{background:var(--bg-hover)}
.se-button:focus-visible,.se-input:focus-visible{outline:var(--focus-ring);outline-offset:1px}
.se-button:disabled{color:var(--text-disabled);cursor:default}
.se-button--primary{background:var(--accent-primary);border-color:var(--accent-primary);color:var(--text-on-accent)}
.se-input{box-sizing:border-box;height:28px;padding:0 8px;border:1px solid var(--border-default);border-radius:6px;background:var(--bg-app);color:var(--text-default);font:inherit}
textarea.se-input{height:auto;padding:6px 8px;resize:vertical}
.se-list{margin:0;padding:0;list-style:none}
.se-list-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 12px;border-bottom:1px solid var(--border-subtle)}
.se-list-row:hover{background:var(--bg-hover)}
`.trim()

export type FrameDocumentInput = {
  surface: { point: string; id: string }
  entryPath: string
  /** The entry and the modules it imports, as source-modules.ts builds them. */
  modules: ReadonlyArray<{ path: string; code: string }>
  token: string
  /** Why its code cannot load (`file:line:col message`): the frame shows it instead. */
  problem?: string
  /** The theme to draw it in; null when this server does not know the client's, which then sends it before anything shows. */
  theme: ExtensionFrameTheme | null
  /** A components panel: its module runs hidden and the window draws the tree it renders. */
  components?: boolean
}

function tokensCss(theme: ExtensionFrameTheme | null): string {
  if (!theme) return ''
  return Object.entries(theme.tokens)
    .filter(([name]) => /^--[a-z0-9-]+$/u.test(name))
    .map(([name, value]) => `${name}:${safeTokenValue(value)};`)
    .join('')
}

export function buildExtensionFrameDocument(input: FrameDocumentInput): string {
  const scheme = input.theme?.colorScheme ?? 'dark'
  return [
    '<!doctype html>',
    `<html class="${scheme}"${input.theme ? '' : ' data-se-waiting'}>`,
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${EXTENSION_FRAME_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="${FRAME_TOKENS_ID}">:root{${tokensCss(input.theme)}}</style>`,
    `<style>${EXTENSION_FRAME_KIT_CSS}</style>`,
    '</head>',
    '<body>',
    `<div id="${FRAME_ROOT_ID}"></div>`,
    `<script>${frameBootstrapScript({
      entryPath: input.entryPath,
      modules: input.modules,
      token: input.token,
      ...(input.problem ? { problem: input.problem } : {}),
      surface: input.surface,
      colorScheme: scheme,
      ...(input.components ? { components: true } : {}),
    })}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

/** A document's hash: sha256 of its UTF-8 bytes, hex. */
export function extensionFrameHash(html: string): string {
  return createHash('sha256').update(html, 'utf8').digest('hex')
}
