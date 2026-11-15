// A chat's container lives as long as the chat (docs/design/container-chats.md;
// owner ruling 2026-11-15): kept after the chat settles, removed when the
// chat is deleted. Main hears every registry change; once no chat is on a
// container any more, and one was, the container goes with its record.
//
// "One was" matters: a container is made before its chat's record exists
// (New chat makes it on Enter, then starts the chat on it), and a deletion of
// some other chat in that moment must not take it. A container whose chat
// never started is not removed here; Settings › Machines › Containers lists
// it, so it is not left unseen.
//
// Removing can fail (Docker not running, the SSH machine away). The container
// is then marked as waiting to be removed, on its saved record, so the mark
// outlives a restart; Settings says why in words, and the removal is tried
// again on every registry change and every few minutes until it goes.

type WorkspaceLike = { id: string; environment?: { kind: string; id: string } | null }

export type ContainerChatLifecycleDeps = {
  /** Every workspace record main holds now. */
  workspaces(): readonly WorkspaceLike[]
  /** Hear each registry change; returns the unsubscriber. */
  subscribe(listener: (event: { type: string }) => void): () => void
  /** The saved machines that are containers, with why one waiting to be removed is still there. */
  containers(): Array<{ id: string; pendingRemoval?: string | null }>
  /** Remove a container and its record. */
  remove(id: string): Promise<{ ok: boolean; message?: string }>
  /** Keep (or clear, with null) the mark that it waits to be removed, and why. */
  markPending(id: string, why: string | null): void
  log?(message: string): void
  /** How often a waiting removal is tried again with nothing else happening. */
  retryMs?: number
}

const RETRY_MS = 5 * 60_000

export function watchContainerChats(deps: ContainerChatLifecycleDeps): () => void {
  const bound = new Set<string>()
  const removing = new Set<string>()
  const used = (): Set<string> => {
    const out = new Set<string>()
    for (const workspace of deps.workspaces())
      if (workspace.environment?.kind === 'ssh' && workspace.environment.id) out.add(workspace.environment.id)
    return out
  }
  const sweep = (): void => {
    const inUse = used()
    for (const container of deps.containers()) {
      const { id } = container
      if (inUse.has(id)) {
        bound.add(id)
        continue
      }
      const pending = typeof container.pendingRemoval === 'string'
      if ((!bound.has(id) && !pending) || removing.has(id)) continue
      removing.add(id)
      // Marked before it is tried, so a quit in the middle still leaves it to be removed.
      if (!pending) deps.markPending(id, 'Removing it now.')
      void deps
        .remove(id)
        .then(
          (result) => {
            if (result.ok) {
              bound.delete(id)
              return
            }
            deps.markPending(id, result.message ?? 'It could not be removed.')
            deps.log?.(`A deleted chat's container was not removed yet: ${result.message ?? ''}`)
          },
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            deps.markPending(id, message)
            deps.log?.(`A deleted chat's container was not removed yet: ${message}`)
          },
        )
        .finally(() => removing.delete(id))
    }
  }
  // The chats already on containers when this process starts are theirs; a waiting removal is tried now.
  sweep()
  const unsubscribe = deps.subscribe(() => sweep())
  const timer = setInterval(sweep, deps.retryMs ?? RETRY_MS)
  timer.unref?.()
  return () => {
    unsubscribe()
    clearInterval(timer)
  }
}
