// Every word the app shows, in one place, so it can be read and cut in one
// sitting and translated later (owner ruling 2026-11-15). A surface imports
// `copy` from `./index` instead of writing its own sentence. Text that varies
// is a function of what it needs, so a translation can reorder or inflect it.
//
// How the words are written:
//
// - A tooltip names the thing or says its state, in a few words: "Up to date",
//   not "SprintEngine Studio is up to date. Click to check again."
// - No "Click to", "Press to", "This will". The control is already a button.
// - No product name where the person is already inside the product.
// - A sentence only when a fragment would mislead. A paragraph never: a
//   tooltip that needs one is the wrong component.
// - `npm run report:copy` lists every entry by length, and every string still
//   written inline in a component, longest first.

export const en = {
  appUpdate: {
    check: 'Check for updates',
    checking: 'Checking for updates…',
    checkFailed: 'Update check failed — retry',
    upToDate: 'Up to date',
    available: (version: string | null) => (version ? `Download update ${version}` : 'Download update'),
    downloadFailed: (version: string | null) =>
      version ? `${version} failed to download — retry` : 'Download failed — retry',
    downloading: (percent: number) => `Downloading update… ${percent}%`,
    ready: (version: string | null) => (version ? `Restart to update to ${version}` : 'Restart to update'),
    installing: 'Installing update…',
    confirmTitle: (version: string | null) => (version ? `Update to ${version}?` : 'Install the update?'),
    confirmBody: (requiresAdmin: boolean) =>
      requiresAdmin
        ? 'Studio restarts on the new version, interrupting working agents. Windows will ask for administrator permission.'
        : 'Studio restarts on the new version, interrupting working agents.',
    confirmLabel: 'Restart to update',
    checkFailedToast: 'Couldn’t check for updates',
    updateFailedToast: 'Update failed',
  },
}

/** The shape every locale fills in. English is the source. */
export type Copy = typeof en
