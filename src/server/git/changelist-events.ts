// A repository's changelists changed: a person's edit through `git.*`, or an
// agent's own list moved by the changelist feed. Every client's
// `git.changelistsChanged` stream hears it, and re-reads that repository's.

const listeners = new Set<(repoRoot: string) => void>()

export function announceChangelistsChanged(repoRoot: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(repoRoot)
    } catch {
      // One listener's failure is not another's.
    }
  }
}

/** Hear each change; returns the unsubscriber. */
export function onChangelistsChanged(listener: (repoRoot: string) => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
