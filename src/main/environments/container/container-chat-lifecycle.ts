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

type WorkspaceLike = { id: string; environment?: { kind: string; id: string } | null }

export type ContainerChatLifecycleDeps = {
  /** Every workspace record main holds now. */
  workspaces(): readonly WorkspaceLike[]
  /** Hear each registry change; returns the unsubscriber. */
  subscribe(listener: (event: { type: string }) => void): () => void
  /** The saved machines that are containers, by id. */
  containerIds(): string[]
  /** Remove a container and its record. */
  remove(id: string): Promise<{ ok: boolean; message?: string }>
  log?(message: string): void
}

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
    for (const id of deps.containerIds()) {
      if (inUse.has(id)) {
        bound.add(id)
        continue
      }
      if (!bound.has(id) || removing.has(id)) continue
      removing.add(id)
      bound.delete(id)
      void deps
        .remove(id)
        .then((result) => {
          if (!result.ok) deps.log?.(`A deleted chat's container was not removed: ${result.message ?? ''}`)
        })
        .catch((error: unknown) =>
          deps.log?.(
            `A deleted chat's container was not removed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
        .finally(() => removing.delete(id))
    }
  }
  // The chats already on containers when this process starts are theirs.
  sweep()
  return deps.subscribe(() => sweep())
}
