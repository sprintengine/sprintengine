import { watch as fsWatch } from 'node:fs'

import { wslHostId } from '../../shared/execution-host'
import { distroOfUncPath } from '../../shared/host-paths'
import { createGitRepoWatch, type GitCheckoutChange, type GitRepoWatch, type WatchFn } from '../../main/git-repo-watch'
import { hostRegistry } from '../../main/hosts/host-registry'
import { invalidateCheckoutSummary } from '../../main/workspace-change-summary'

// The checkouts this process watches (git-repo-watch.ts), and who hears their
// changes. A client's `git.checkoutChanged` stream retains its checkout for as
// long as it is open and releases it when it ends, a closed connection's
// streams included, so a reloaded window gives back what its page held. The
// desktop's shell also notes agent activity on it (app-services).

let sharedWatch: GitRepoWatch | null = null
const listeners = new Set<(changes: GitCheckoutChange[]) => void>()

function deliver(changes: GitCheckoutChange[]): void {
  // The held sidebar reading for a checkout that moved is dropped first, so
  // the re-read these changes cause is a real one.
  for (const change of changes) invalidateCheckoutSummary(change.checkoutKey)
  for (const listener of [...listeners]) {
    try {
      listener(changes)
    } catch {
      // One listener's failure is not another's.
    }
  }
}

/**
 * A git directory's watch, placed where its events are heard. On Windows a
 * directory inside a WSL distribution (`\\wsl.localhost\<distro>\…`) is
 * watched by that distribution's helper, because Windows accepts a watch on
 * that share and then reports nothing; everything else is an ordinary
 * `fs.watch`.
 */
export const watchGitDirOnHost: WatchFn = (path, options, listener) => {
  const distro = process.platform === 'win32' ? distroOfUncPath(path) : null
  const host = distro ? hostRegistry().get(wslHostId(distro)) : null
  if (host?.kind === 'wsl' && host.watchDir) {
    return host.watchDir(path, options.recursive, (filename) => listener('change', filename))
  }
  return fsWatch(path, options, (event, filename) => listener(event, typeof filename === 'string' ? filename : null))
}

/** The process-wide watch. */
export function getGitRepoWatch(): GitRepoWatch {
  sharedWatch ??= createGitRepoWatch({ emit: deliver, watch: watchGitDirOnHost })
  return sharedWatch
}

/** Hear every batch of checkout changes; returns the unsubscriber. */
export function onCheckoutChanges(listener: (changes: GitCheckoutChange[]) => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
