import { useEffect, useState } from 'react'

import type {
  ConversationChangedFileSide,
  ConversationChangedFileSides,
} from '../../../../../packages/conversation-protocol/src/checkoutChanges'
import type { BranchStepDiff, BranchStepSelection, BranchStepsSnapshot } from '../../../../shared/electron-api'
import type { MeshConversationKey } from '../../../../shared/tailnet-mesh'
import type { StudioClient } from '../../../../../packages/client-runtime/src/public'
import { STUDIO_CONVERSATIONS_CAPABILITY } from '../../../../../packages/studio-protocol/src/public'
import { environmentRefusal, pairedTarget, withEnvironmentStudio } from '../../studio/environmentStudio'
import { environmentConversationTransport } from '../panels/agentChat/environmentChat'

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
  return `paired:${key.connectionId}/${key.workspaceId}/${key.agentId}`
}

/**
 * The changes of a chat on a paired machine, read from that machine over this
 * window's own client of it. It follows the chat's changes (`conversation.changes`)
 * while anyone reads them, so the readings arrive whether or not the chat's
 * own pane is open in this window; the client follows again after a drop and
 * is told how the checkout stands now.
 */
export function createPairedDiffSource(input: { key: MeshConversationKey; machineName: string }): DiffViewerSource {
  const { key, machineName } = input
  const target = pairedTarget({ id: key.connectionId, machineName })
  const services = environmentConversationTransport(target).services
  const chat = { workspaceId: key.workspaceId, agentId: key.agentId }
  const listeners = new Set<(reading: DiffSourceReading) => void>()
  let last: DiffSourceReading | null = null
  let stop: (() => void) | null = null
  const tell = (reading: DiffSourceReading) => {
    last = reading
    for (const listener of listeners) listener(reading)
  }
  const start = (): (() => void) => {
    const follow = services.followPush
    if (!follow) {
      tell({ state: 'error', message: `${machineName} cannot be reached from this window.` })
      return () => undefined
    }
    return follow({
      topic: 'conversation.changes',
      params: { key: chat },
      capability: STUDIO_CONVERSATIONS_CAPABILITY,
      onPayload: (frame) =>
        tell(
          frame.changes
            ? {
                state: 'ready',
                snapshot: { ...frame.changes, steps: frame.changes.steps.map((step) => ({ ...step })) },
                revision: frame.revision,
              }
            : { state: 'not-git' },
        ),
    })
  }
  const ask = <T>(work: (client: StudioClient) => Promise<T>): Promise<T> =>
    withEnvironmentStudio(target, work).catch((error: unknown) => {
      throw new Error(environmentRefusal(target, error).message)
    })
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
      const diff = await ask((client) => client.request('conversation.changesDiff', { key: chat, selection }))
      return { files: diff.files, additions: diff.additions, deletions: diff.deletions }
    },
    async file(selection, path) {
      const sides = await ask((client) => client.request('conversation.changedFile', { key: chat, selection, path }))
      return { original: sides.original, modified: sides.modified }
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
