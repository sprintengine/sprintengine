# Components sample: three panels drawn with Studio's own controls

A sample of components panels (`"ui": "components"`): each panel's module
renders a tree of Studio's components, and Studio draws them with its own
controls, in light and dark, with its keyboard and focus rules. There is no
HTML, no CSS and no build step: Studio compiles the `.tsx` as written.

- **Counter** (`src/counter.tsx`): a count in a `persist: 'plugin'` atom, so
  Studio keeps it across restarts, the same in every workspace. Its
  `src/counter.check.ts` names the states `check` renders it in: fresh,
  pressed before, and dark.
- **Request form** (`src/form.tsx`): an Input, a Select and a Switch, with
  Studio owning what the person types. The draft is a keyed memory atom, so a
  save while the folder is loaded for development keeps half-typed text.
- **Files** (`src/files.tsx`): a sortable, selectable Table and a Tree. The
  panel holds the sort and the selection and hands the rows over in order.

Load it as a development folder, from this folder, and approve it once in
Studio's window:

```sh
npx sprintengine-extension dev load .
npx sprintengine-extension check .     # renders each panel, once per scenario
npx sprintengine-extension shot . --panel files
```

It asks for no permissions. The `components` guide topic is the reference;
the SDK's tests load this folder, render every panel and use each one as the
person would (`test/components-sample.test.ts`).
