import React from 'react'

import { formatEnvironmentRoute } from '../../../../packages/studio-protocol/src/environment'
import type { EnvironmentEntry } from '../../../shared/environments'

// The machines this desktop knows, as every surface in this window draws them
// (design-environments): one store per window however many components ask,
// started by its first subscriber and stopped with its last. The list is read
// once and again on every push that says it reads differently; a read that
// lands after a newer one is dropped.

type Store = {
  environments: readonly EnvironmentEntry[]
  listeners: Set<() => void>
  stop: (() => void) | null
  asked: number
}

const store: Store = { environments: [], listeners: new Set(), stop: null, asked: 0 }
const EMPTY: readonly EnvironmentEntry[] = []

type Bridge = Pick<Window['api'], 'environmentsList' | 'onEnvironmentsChanged'>

function bridge(): Bridge | null {
  const api = typeof window !== 'undefined' ? (window.api as Partial<Window['api']> | undefined) : undefined
  return api && typeof api.environmentsList === 'function' && typeof api.onEnvironmentsChanged === 'function'
    ? (api as Bridge)
    : null
}

function read(api: Bridge): void {
  const ticket = ++store.asked
  void api
    .environmentsList()
    .then((listed) => {
      if (ticket !== store.asked || !Array.isArray(listed)) return
      store.environments = listed
      for (const listener of [...store.listeners]) listener()
    })
    .catch(() => undefined)
}

function subscribe(listener: () => void): () => void {
  store.listeners.add(listener)
  if (!store.stop) {
    const api = bridge()
    if (api) {
      const off = api.onEnvironmentsChanged(() => read(api))
      store.stop = off
      read(api)
    }
  }
  return () => {
    store.listeners.delete(listener)
    if (store.listeners.size === 0 && store.stop) {
      store.stop()
      store.stop = null
    }
  }
}

/** Every machine this desktop knows, this one first. Empty until the first read lands. */
export function useEnvironments(): readonly EnvironmentEntry[] {
  return React.useSyncExternalStore(
    subscribe,
    () => store.environments,
    () => EMPTY,
  )
}

/** Ask the owner of an environment's best route to try it again now. */
export function retryEnvironment(entry: Pick<EnvironmentEntry, 'routes'>): Promise<void> {
  const api = typeof window !== 'undefined' ? (window.api as Partial<Window['api']> | undefined) : undefined
  if (typeof api?.environmentsRetry !== 'function') return Promise.resolve()
  return api.environmentsRetry(formatEnvironmentRoute(entry.routes[0]!))
}

/** Test seam: forget what the store holds. */
export function resetEnvironmentsForTests(): void {
  store.stop?.()
  store.stop = null
  store.environments = []
  store.listeners.clear()
  store.asked = 0
}
