# Callout

A boxed note inside a panel's content: an optional title, the note, and a
tone. It is what an extension's components panel draws for `Callout`, through
the shipped `Callout` primitive (`src/renderer/src/components/ui/Callout.tsx`).

**Why not the inline notice.** The [inline notice](../inline-notice/component.md)
has two tones on purpose — a failure and a degraded state — and there is no
info or success notice. A panel's author still needs a box for "read this
first", so the callout's `warning` and `danger` are the notice's own treatment
(its soft fill, and the notice's role), and its `neutral`, `accent` and
`success` stay content: a hairline box on the surface, with the tone in the
title's ink only, never a tinted field.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Box | `.ds-callout` | yes — `border.subtle` hairline, `radius.control`, `bg.surface` |
| Glyph | `.ds-callout-glyph` | no — `icon.size.sm`, before the title |
| Title | `.ds-callout-title` | no — `text.primary` at `font.weight.emphasis` |
| Body | `.ds-callout-body` | yes — the note's content |

## Variants

- **Neutral** (default) — the box alone.
- **`--accent`** — the title in `accent.primary` ink.
- **`--success`** — the title in `status.good` ink.
- **`--warning`** — the inline notice's warn treatment: `status.warn-soft` ground.
- **`--danger`** — the inline notice's error treatment: `status.danger-soft` ground.

## States

A callout is not interactive. A control inside it keeps its own states.

## Usage

- One callout per thing to read; do not stack them as a list of facts.
- Put what to do next in the body, as a button or a link.
- For a failure the person must act on in the app's own chrome, use the inline
  notice or a banner, not this.

## Accessibility

- `danger` is `role="alert"`, `warning` is `role="status"`, the rest
  `role="note"`.
- The tone is never colour alone: the title or the body says it in words.
