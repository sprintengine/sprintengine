// The main half of `extension.open`: find a window of this machine that shows
// a workspace, and have it show an extension's panel or open a file in its
// custom editor there.
//
// Main does not know which workspace a window shows, so it asks. Unlike the
// editor reveal, which names a workspace and so can ask every window at once,
// this request names none: every window showing a workspace would open it, and
// the person would find it in each. So the windows are asked ONE AT A TIME,
// the one the person is in first, then the ones on screen, then the rest, and
// the first that opens it ends the search.
//
// Nothing here raises, shows or focuses a window: the person sees it when they
// look (extension-open.ts). A window that does not answer in time is passed
// over, the honest reading of silence being that it shows nothing to open in.
//
// Electron-free: a target is anything that can be sent a message, recognised
// again when it answers and asked whether it is focused or on screen, so the
// rules are testable with plain objects.

import { randomUUID } from 'node:crypto'

import type { ExtensionOpenOutcome, ExtensionOpener, ExtensionOpenRequest } from '../shared/extension-open'
import {
  EXTENSION_OPEN_REQUEST_CHANNEL,
  readExtensionOpenAck,
  type ExtensionOpenWindowRequest,
} from '../shared/extension-open-ipc'

export type ExtensionOpenTarget = {
  /** Identity, compared with the sender of an answer. */
  id: unknown
  isDestroyed(): boolean
  /** The person is in this window now. */
  isFocused(): boolean
  /** On screen: shown and not minimized. */
  isVisible(): boolean
  send(channel: string, payload: unknown): void
}

/**
 * How long one window gets to answer. A window answers as soon as it has put
 * the tab up, well inside this; a window still loading, or hung, costs the
 * request this much before the next window is asked.
 */
export const EXTENSION_OPEN_WAIT_MS = 3_000

export const NO_WINDOW_MESSAGE = 'No Studio window is open on this machine: open Studio and try again.'
export const NO_WORKSPACE_MESSAGE =
  'No Studio window on this machine is showing a workspace: open a workspace in Studio and try again.'

export type ExtensionOpenBrokerDeps = {
  /** The workspace windows: never an aux window, the splash or a worker window. */
  targets: () => ExtensionOpenTarget[]
  newRequestId?: () => string
  waitMs?: number
}

export type ExtensionOpenBroker = {
  open: ExtensionOpener
  /** Wired to the windows' answers. `from` is the answering window, resolved by the transport. */
  handleAck(from: unknown, payload: unknown): void
  dispose(): void
}

type Waiter = { from: unknown; settle: (outcome: ExtensionOpenOutcome | null) => void }

/** The order windows are asked in: the focused one, then the ones on screen, then the rest, each in list order. */
function askingOrder(targets: ExtensionOpenTarget[]): ExtensionOpenTarget[] {
  const rank = (target: ExtensionOpenTarget): number => (target.isFocused() ? 0 : target.isVisible() ? 1 : 2)
  return targets
    .map((target, index) => ({ target, index, rank: rank(target) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.target)
}

export function createExtensionOpenBroker(deps: ExtensionOpenBrokerDeps): ExtensionOpenBroker {
  const newRequestId = deps.newRequestId ?? randomUUID
  const waitMs = deps.waitMs ?? EXTENSION_OPEN_WAIT_MS
  const waiters = new Map<string, Waiter>()
  let disposed = false

  /** Ask one window; null when it did not answer in time or went away. */
  function askOne(target: ExtensionOpenTarget, request: ExtensionOpenRequest): Promise<ExtensionOpenOutcome | null> {
    const requestId = newRequestId()
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const settle = (outcome: ExtensionOpenOutcome | null): void => {
        if (!waiters.has(requestId)) return
        waiters.delete(requestId)
        if (timer) clearTimeout(timer)
        resolve(outcome)
      }
      // In place before the send: a window answering in the same tick must
      // find someone listening.
      waiters.set(requestId, { from: target.id, settle })
      timer = setTimeout(() => settle(null), waitMs)
      const ask: ExtensionOpenWindowRequest = { ...request, requestId }
      try {
        target.send(EXTENSION_OPEN_REQUEST_CHANNEL, ask)
      } catch {
        // A window torn down between the check and the send.
        settle(null)
      }
    })
  }

  return {
    async open(request) {
      if (disposed) return { ok: false, code: 'no_window', message: NO_WINDOW_MESSAGE }
      const ordered = askingOrder(deps.targets().filter((target) => !target.isDestroyed()))
      if (ordered.length === 0) return { ok: false, code: 'no_window', message: NO_WINDOW_MESSAGE }
      let notFound: ExtensionOpenOutcome | null = null
      for (const target of ordered) {
        // A window closed while an earlier one was being asked.
        if (disposed || target.isDestroyed()) continue
        const outcome = await askOne(target, request)
        if (!outcome) continue
        if (outcome.ok) return outcome
        // A window that shows a workspace but lacks the panel or editor is
        // the more telling answer, kept in case no other window opens it.
        if (outcome.code === 'not_found') notFound ??= outcome
      }
      // The app is closing its windows: none is left to show it.
      if (disposed) return { ok: false, code: 'no_window', message: NO_WINDOW_MESSAGE }
      return notFound ?? { ok: false, code: 'no_workspace', message: NO_WORKSPACE_MESSAGE }
    },

    handleAck(from, payload) {
      const ack = readExtensionOpenAck(payload)
      if (!ack) return
      const waiter = waiters.get(ack.requestId)
      // Only the window this ask went to may answer it.
      if (!waiter || waiter.from !== from) return
      waiter.settle(ack.outcome)
    },

    dispose() {
      disposed = true
      for (const waiter of [...waiters.values()]) waiter.settle(null)
    },
  }
}
