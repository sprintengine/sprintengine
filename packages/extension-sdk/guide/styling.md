# Styling: drawing a surface yourself

A panel, door or settings section is drawn by the extension's own code, in a
sandboxed frame of its own. Studio hands its `mount(root, studio)` the frame's
root element and gets out of the way. It lends no components and shares no
React: whatever the surface draws with, it brings.

## The entry

Each surface's `entry` in extension.json is a module Studio loads into the
frame as written: TypeScript and JSX have their types and JSX removed, and the
files it imports by relative paths come with it. A package by name (`react`,
anything from `node_modules`) is refused: nothing resolves it. Plain DOM is
the default, and what the templates do:

```ts
import type { ExtensionMount } from '@sprintengine/extension-sdk'

export const mount: ExtensionMount = (root, studio) => {
  const heading = root.ownerDocument.createElement('p')
  heading.className = 'se-heading'
  heading.textContent = 'Hello.'
  root.append(heading)
  studio.ready()
  return () => heading.remove()
}
```

- **Return a cleanup.** Studio calls it when the surface closes. Remove what
  you drew, stop timers, drop listeners.
- **Call `studio.ready()` once your content is drawn**, not when `mount`
  starts. Studio measures how long a surface takes from being opened to that
  call. A surface that loads data says ready after the first real paint of it.
- **JSX works, in the classic form.** In a `.tsx` or `.jsx` file `<b>x</b>`
  calls `h('b', null, 'x')` and `<>` is `Fragment`. Import both from a file of
  your own: a few lines that build DOM elements, or a small library's ESM
  file copied into the extension.
- **A framework is yours to bring.** To draw with React or another library,
  copy its ESM build into the extension, or bundle it yourself into one file
  under `extension/` and import that by a relative path. Studio shares none
  with extensions.

## Colours

Studio puts the person's theme in the frame as CSS custom properties, and
updates them in place when the theme changes. Style with them and the surface
follows every theme, light and dark:

| Family | Properties |
| --- | --- |
| Backgrounds | `--bg-app`, `--bg-surface`, `--bg-surface-raised`, `--bg-hover`, `--bg-selected` |
| Text | `--text-strong`, `--text-default`, `--text-muted`, `--text-subtle`, `--text-disabled`, `--text-on-accent` |
| Lines | `--border-subtle`, `--border-default`, `--border-strong` |
| Accent and tones | `--accent-primary`, `--accent-primary-soft`, `--focus-ring`, `--tone-neutral`, `--tone-accent`, `--tone-warn`, `--tone-good`, `--tone-error`, `--tone-merged` |
| Charts | `--chart-1` … `--chart-8`, `--chart-other` |
| Motion | `--motion-normal`, `--motion-ease` |

The list is `THEME_TOKENS` in `@sprintengine/extension-sdk`. Only the names are
a contract: values differ per theme and change between releases, so never
copy them as hex. A soft fill of a colour is
`color-mix(in srgb, var(--accent-primary) 15%, transparent)`. The frame's
`<html>` carries the class `light` or `dark`, and `studio.theme.colorScheme`
says the same to a runtime that needs a concrete scheme (an editor's base
theme, a chart library's palette); `studio.on('theme', …)` hears it change.

## Studio's kit

The frame carries a small stylesheet so a surface looks like Studio with no
CSS of its own: the body has Studio's ground, text colour and type, and these
classes draw its controls:

| Class | What |
| --- | --- |
| `se-heading` | A section heading |
| `se-muted` | Secondary text |
| `se-button`, `se-button se-button--primary` | A button, and the one accent action of a surface |
| `se-input` | A text field (`input` or `textarea`) |
| `se-list`, `se-list-row` | A plain list, and a row with a line under it |

## Your own CSS

The frame is the surface's own document: a `<style>` in its head, rules on
`body`, and any class names you like touch nothing of Studio's. Write plain
CSS or inline styles on the properties above.

A frame cannot import a CSS file: keep the stylesheet in a string in one of
your modules and append it in `mount`.

```ts
// styles.ts
export const STYLES = `
.notes { display: flex; flex-direction: column; height: 100%; }
.notes__state { color: var(--text-muted); }
`

// notes.ts
import { STYLES } from './styles'

export const mount: ExtensionMount = (root, studio) => {
  const style = root.ownerDocument.createElement('style')
  style.textContent = STYLES
  root.ownerDocument.head.append(style)
  // … draw into root, then studio.ready()
  return () => style.remove()
}
```

- **Fill the frame.** The root has the frame's size; give your outer element
  `height: 100%` and let it scroll inside.

## Looking like Studio

- **No status dots.** State is a word, a lifecycle glyph or a timer, never a
  little coloured circle.
- **Agent text is untrusted.** Render it as text. Never put agent output or a
  fetched page through `innerHTML` or `dangerouslySetInnerHTML`.
- **Keyboard first.** Real `<button>`s and `<input>`s, a visible focus, and
  labels on every control.
- **Quiet by default.** One accent action per surface; everything else is
  plain text or a bordered control on `--bg-surface`.

## Images, fonts and other files

The frame reaches no network and no file: what it shows comes from its own
modules. Inline images and fonts as `data:` URLs in a module it imports (an
`export const LOGO = 'data:image/svg+xml;base64,…'`), or build `blob:` URLs
from bytes you hold. Data the surface reads from a workspace comes through
`files.read` (permission `workspace-files:read`).
