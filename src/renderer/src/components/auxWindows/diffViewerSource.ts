import { useEffect, useState } from 'react'

import type {
  ConversationChangedFileSide,
  ConversationChangedFileSides,
} from '../../../../../packages/conversation-protocol/src/checkoutChanges'
import type { BranchStepDiff, BranchStepSelection, BranchStepsSnapshot } from '../../../../shared/electron-api'
import type { MeshConversationKey } from '../../../../shared/tailnet-mesh'
import { pairedCheckoutRoot } from '../../utils/pairedCheckout'

// Where a diff viewer reads a checkout that is not on this computer: a chat on
// a paired machine, whose machine reads its checkout as its own Diff tab does
// and says what it found (`conversation-changes`). The viewer is the same one;
// only where its four readings come from moves — how the checkout stands, a
// step's files, a file's two sides, and when to read them again. A viewer
// with no source reads this computer's checkout through git, as it always has.

/** How the checkout stands, as its machine last said, and the tick that says it moved. */
export type DiffSourceReading =
  | { state: 'loading' }
  | { state: 'ready'; snapshot: BranchStepsSnapshot; revision: string }
  | { state: 'not-git' }
  | { state: 'error'; message: string }

export type DiffViewerSource = {
  /** What its files are kept under here: their paths' root, and the viewed marks' key. Names no folder. */
  root: string
  /** The machine the checkout is on, for words. */
  machineName: string
  /** The chat these are the changes of, which "Add to chat" quotes into. */
  chatAgentId: string
  /** Follow how the checkout stands. Told now when it is known, and whenever it moves; returns what stops it. */
  watch(listener: (reading: DiffSourceReading) => void): () => void
  /** One step's files. Throws with the machine's words when it cannot. */
  stepDiff(selection: BranchStepSelection): Promise<BranchStepDiff>
  /** One file's two sides, by its path as the step lists it. Throws with the machine's words when it cannot. */
  file(selection: BranchStepSelection, path: string): Promise<ConversationChangedFileSides>
}

export type { ConversationChangedFileSide }

/** What the files of a paired machine's chat are kept under here: the chat, as no folder of this disk names it. */
export function pairedChangesRoot(key: MeshConversationKey): string {
  // The same root its Files tab keeps the chat's folder under, so a file of
  // the changes and the same file in the tree are one path.
  return pairedCheckoutRoot(key)
}

/** How long to wait before asking again for a watch the machine's link was not ready for. */
const WATCH_RETRY_MS = 500
const WATCH_RETRIES = 10

/**
 * The changes of a chat on a paired machine, read from that machine. It
 * follows the chat while anyone reads them, so the readings arrive whether or
 * not the chat's own pane is open in this window, and asks the machine to say
 * how the checkout stands for as long as it does.
 */
export function createPairedDiffSource(input: { key: MeshConversationKey; machineName: string }): DiffViewerSource {
  const { key, machineName } = input
  const listeners = new Set<(reading: DiffSourceReading) => void>()
  let last: DiffSourceReading | null = null
  let stop: (() => void) | null = null
  const tell = (reading: DiffSourceReading) => {
    last = reading
    for (const listener of listeners) listener(reading)
  }
  const start = () => {
    let ended = false
    let retry: ReturnType<typeof setTimeout> | null = null
    const unfollow = window.api.onMeshConversationSession({ key }, (frame) => {
      if (frame.type !== 'changes') return
      tell(
        frame.changes
          ? {
              state: 'ready',
              snapshot: { ...frame.changes, steps: frame.changes.steps.map((step) => ({ ...step })) },
              revision: frame.revision,
            }
          : { state: 'not-git' },
      )
    })
    const ask = (attempt: number) => {
      void window.api.meshConversationWatchChanges({ key, watching: true }).then(
        (result) => {
          if (ended || result.ok) return
          // The follow it rides on is a moment behind on its first open.
          if (result.code === 'not_following' && attempt < WATCH_RETRIES) {
            retry = setTimeout(() => ask(attempt + 1), WATCH_RETRY_MS)
            return
          }
          tell({ state: 'error', message: result.message })
        },
        (failure: unknown) => {
          if (!ended) tell({ state: 'error', message: failure instanceof Error ? failure.message : String(failure) })
        },
      )
    }
    ask(0)
    return () => {
      ended = true
      if (retry) clearTimeout(retry)
      void window.api.meshConversationWatchChanges({ key, watching: false }).catch(() => undefined)
      unfollow()
    }
  }
  return {
    root: pairedChangesRoot(key),
    machineName,
    chatAgentId: key.agentId,
    watch(listener) {
      listeners.add(listener)
      if (last) listener(last)
      if (!stop) stop = start()
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0 || !stop) return
        stop()
        stop = null
        last = null
      }
    },
    async stepDiff(selection) {
      const result = await window.api.meshConversationChangesDiff({ key, selection })
      if (!result.ok) throw new Error(result.message)
      return { files: result.files, additions: result.additions, deletions: result.deletions }
    },
    async file(selection, path) {
      const result = await window.api.meshConversationChangedFile({ key, selection, path })
      if (!result.ok) throw new Error(result.message)
      return { original: result.original, modified: result.modified }
    },
  }
}

/**
 * How a source's checkout stands, and a tick that moves once each time its
 * machine says it moved: what a viewer of this computer's checkout reads off
 * `git status` and its tree revision. Zero until the machine has said anything.
 */
export function useDiffSourceReading(source: DiffViewerSource | null): { reading: DiffSourceReading; tick: number } {
  const [state, setState] = useState<{ reading: DiffSourceReading; tick: number }>(LOADING)
  useEffect(() => {
    setState(LOADING)
    if (!source) return
    let lastRevision: string | null = null
    return source.watch((reading) => {
      const revision = reading.state === 'ready' ? `ready:${reading.revision}` : reading.state
      if (revision === lastRevision) {
        setState((current) => ({ ...current, reading }))
        return
      }
      lastRevision = revision
      setState((current) => ({ reading, tick: current.tick + 1 }))
    })
  }, [source])
  return state
}

const LOADING: { reading: DiffSourceReading; tick: number } = { reading: { state: 'loading' }, tick: 0 }
