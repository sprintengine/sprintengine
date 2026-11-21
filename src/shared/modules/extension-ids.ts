// How an installed extension's contributions are named in the shell's own
// registries (doors, settings sections, top bar items, pane tabs), where the
// app's modules share one namespace: the install key, then the id the
// extension.json gives. The manifest's ids are unique within one extension;
// the key keeps two extensions, and the app's own surfaces, apart.

export function extensionSurfaceId(key: string, id: string): string {
  return `${key}:${id}`
}
