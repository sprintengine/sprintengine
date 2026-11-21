# Styling: drawing a surface yourself

A panel, door or settings section is drawn by the extension's own code. Studio
hands its `mount(root, studio)` an element and gets out of the way. It lends no
components and shares no React: whatever the surface draws with, it brings.

## The entry

Each ui `entry` in extension.json is one ESM file that Studio imports as a
blob module. Nothing beside it resolves, so the file must hold everything it
imports, React included. The template's `scripts/build-ui.mjs` builds
`extension/dist/<name>.js` from `src/<name>.tsx` for each entry extension.json
names, bundled whole.

```tsx
import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import type { ExtensionMount, ExtensionMountStudio } from '@sprintengine/extension-sdk'

function Hello({ studio }: { studio: ExtensionMountStudio }) {
  useEffect(() => studio.ready(), [])
  return <p className="acme-hello">Hello.</p>
}

export const mount: ExtensionMount = (root, studio) => {
  const view = createRoot(root)
  view.render(<Hello studio={studio} />)
  return () => view.unmount()
}
```

- **Return a cleanup.** Studio calls it when the surface closes. Unmount what
  you rendered, stop timers, drop subscriptions.
- **Call `studio.ready()` once your content is drawn**, not when `mount`
  starts. Studio measures how long a surface takes from being opened to that
  call. A surface that loads data says ready after the first real paint of it.
- **Plain DOM works too.** A small surface needs no React: build elements with
  `root.ownerDocument.createElement` and append them to `root`.

## Colours, spacing and type

The surface sits in Studio's document, so Studio's CSS custom properties reach
it. Style with them and the surface follows every theme, light and dark:

| Family | Properties |
| --- | --- |
| Backgrounds | `--sem-color-bg-app`, `--sem-color-bg-surface`, `--sem-color-bg-surface-raised`, `--sem-color-bg-hover`, `--sem-color-bg-selected` |
| Text | `--sem-color-text-primary`, `--sem-color-text-default`, `--sem-color-text-muted`, `--sem-color-text-subtle`, `--sem-color-text-disabled` |
| Lines | `--sem-color-border-subtle`, `--sem-color-border-default`, `--sem-color-border-strong` |
| Accent and states | `--sem-color-accent-primary`, `--sem-color-status-warn`, `--sem-color-status-danger`, `--sem-focus-ring` |
| Spacing | `--sem-space-xs`, `--sem-space-sm`, `--sem-space-md`, `--sem-space-lg` |
| Type | `--sem-font-family-ui`, `--sem-font-family-mono`, `--sem-font-size-body`, `--sem-font-size-meta` |
| Shape | `--sem-radius-control` |

Only the names are a contract. Values differ per theme and change between
releases, so never read them into JavaScript or copy them as hex. A soft fill
of a colour is `color-mix(in srgb, var(--sem-color-accent-primary) 15%, transparent)`.

A runtime that needs a concrete scheme (an editor's base theme, a chart
library's palette) reads `studio.watchColorScheme(cb)`, which answers
`'light'` or `'dark'` at once and again on every change.

## Your own CSS

Studio's stylesheet is built from Studio's own source, so a utility class you
write (`flex gap-2`) has no rule behind it. Write plain CSS, or inline styles,
on the properties above.

- **Put your `<style>` inside the root you are given**, not in the document's
  head. It then leaves with the surface. Render into a child of `root` so the
  framework that owns the child never removes the style:

  ```ts
  import css from './notes.css'   // esbuild: --loader:.css=text

  export const mount: ExtensionMount = (root, studio) => {
    const style = root.ownerDocument.createElement('style')
    style.textContent = css
    const content = root.ownerDocument.createElement('div')
    root.append(style, content)
    const view = createRoot(content)
    view.render(<Notes studio={studio} />)
    return () => {
      view.unmount()
      style.remove()
      content.remove()
    }
  }
  ```

- **Prefix every selector** with something of your own (the extension id). The
  document is shared with Studio and with other extensions' surfaces, and an
  unprefixed `.row` or `button` rule styles theirs too.
- **Never style outside your root.** No rules on `body`, `html` or Studio's own
  classes.
- **Fill the root.** A panel's root has the pane's size; give your outer
  element `height: 100%` and let it scroll inside.

## Looking like Studio

- **No status dots.** State is a word, a lifecycle glyph or a timer, never a
  little coloured circle.
- **Agent text is untrusted.** Render it as text. Never put agent output or a
  fetched page through `innerHTML` or `dangerouslySetInnerHTML`.
- **Keyboard first.** Real `<button>`s and `<input>`s, a visible focus
  (`box-shadow: var(--sem-focus-ring)`), and labels on every control.
- **Quiet by default.** One accent action per surface; everything else is
  plain text or a bordered control on `--sem-color-bg-surface`.

## Files the surface loads

The bundle runs from a blob URL, so a relative URL resolves to nothing. Ship
the file inside `extension/` and ask for its URL with
`studio.getAssetUrl('assets/logo.svg')`. For an HTML or WebAssembly runtime,
point an iframe at `studio.getAssetUrl('runtime/index.html')`; inside it,
relative URLs work.
