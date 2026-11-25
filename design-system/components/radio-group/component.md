# Radio group

A choose-one list of rows: each row is a choice, with the
[checkbox](../checkbox/component.md)'s radio mark as its picture, a label, and
an optional line saying what the choice means. Extracted from the shipped
`RadioGroup` primitive (`src/renderer/src/components/ui/RadioGroup.tsx`).

It is the "radiogroup of rows" the checkbox's radio mark was drawn for. Reach
for it when each choice needs a sentence to be understood, or when there are
more than a segmented control holds (2–4 short words). A value picked from a
long closed list with no explanation is a [select](../select/component.md).

## Anatomy

| Part | Class | Required |
|---|---|---|
| Group | `.ds-radio-group` | yes — `role="radiogroup"` with an accessible name |
| Row | `.ds-radio-group-row` | yes — `role="radio"`, `aria-checked`; the tab stop when chosen |
| Mark | `.ds-radio-group-mark` | yes — the radio mark, `aria-hidden` |
| Label | `.ds-radio-group-label` | yes — `text.default` at `font.size.body` |
| Description | `.ds-radio-group-description` | no — `text.muted` at `font.size.meta`, under the label |

## Variants

- **Vertical** (default) — one row under another, `space.xs` apart.
- **`--horizontal`** — rows side by side, wrapping, `space.lg` apart. Only for
  short labels with no descriptions.

## States

| State | Treatment |
|---|---|
| Rest | the mark's well, label in `text.default` |
| Hover | the row takes `bg.hover` |
| Chosen | the mark's accent fill and disc |
| Focus | the shared focus ring on the row |
| Disabled | the row at the kit's 45% fade, `aria-disabled`, still in the walk |

## Usage

- One choice is always the answer once chosen; a group never clears itself.
- Keep labels to a few words and put the explanation in the description.
- Do not mix a radio group and checkboxes in one list.

## Accessibility

- `role="radiogroup"` with `aria-label` (or `aria-labelledby`) on the group.
- Each row is `role="radio"` with `aria-checked`, and the chosen row (or the
  first enabled one when none is) is the one tab stop.
- Arrow keys move the choice to the next or previous enabled row and choose it;
  Home and End go to the first and last. Space chooses the focused row.
- A description is the row's `aria-describedby`.
