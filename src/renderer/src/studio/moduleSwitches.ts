import type { StudioModuleSummary } from '../../../../packages/studio-protocol/src/public'
import { extensionsApi } from './extensions'
import { windowModuleLifecycle } from './moduleLifecycle'
import { watchWindowStudio, windowStudioState } from './windowStudioClient'

// The person's module switches, as the window's Studio holds them. The Studio
// keeps each switch and starts or stops what runs there (`module.setEnabled`);
// the window keeps a copy (`appSettings.modules`) that decides which of its
// own window halves load. The Studio's word is the one that counts:
//
// - a switch is sent to the Studio and waited for, and the window's copy
//   changes only once the Studio has it, so a switch that failed is said,
//   and the window never shows a module on that its Studio left off;
// - whenever the window's connection opens and whenever what is installed
//   changes (`module.changed`), the window reads what its Studio holds
//   (`module.list`) and takes the Studio's choice for every module it lists.
//
// A module only the window has (a window-only bundled module) is the window's
// own: its switch is still sent, so the Studio keeps the choice, but no list
// overrides it.

export type ModuleSwitchStore = {
  overrides(): Record<string, boolean>
  /** The window's copy of one switch. */
  set(moduleId: string, enabled: boolean): void
}

export type StudioModuleSwitches = {
  /** What the Studio last said about each module it holds, by id; empty before it has answered. */
  modules(): ReadonlyMap<string, StudioModuleSummary>
  /** Hear each time the Studio's answer changes. Returns the unsubscriber. */
  onChange(listener: () => void): () => void
  /** Switch a module on or off on the Studio, then in the window's copy. */
  switchModule(moduleId: string, enabled: boolean): Promise<{ ok: true } | { ok: false; message: string }>
  /** Read the Studio's list again now. */
  refresh(): Promise<void>
}

export function createStudioModuleSwitches(deps: {
  store: ModuleSwitchStore
  list: () => Promise<StudioModuleSummary[]>
  setEnabled: (
    moduleId: string,
    enabled: boolean,
  ) => Promise<{ ok: true; module: StudioModuleSummary | null } | { ok: false; message: string }>
}): StudioModuleSwitches {
  let known = new Map<string, StudioModuleSummary>()
  const listeners = new Set<() => void>()
  const told = () => {
    for (const listener of [...listeners]) listener()
  }
  // Reads may overlap (a reconnect and a change together); only the last asked lands.
  let asked = 0

  function adopt(summary: StudioModuleSummary): void {
    const overrides = deps.store.overrides()
    if (overrides[summary.id] !== summary.enabled) deps.store.set(summary.id, summary.enabled)
  }

  async function refresh(): Promise<void> {
    const mine = ++asked
    let listed: StudioModuleSummary[]
    try {
      listed = await deps.list()
    } catch {
      // No answer: what was last said stands, and the next open asks again.
      return
    }
    if (mine !== asked) return
    known = new Map(listed.map((summary) => [summary.id, summary]))
    for (const summary of listed) adopt(summary)
    told()
  }

  return {
    modules: () => known,
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async switchModule(moduleId, enabled) {
      const answer = await deps.setEnabled(moduleId, enabled)
      if (!answer.ok) {
        // What runs may still have changed in part: read it again.
        void refresh()
        return { ok: false, message: answer.message }
      }
      deps.store.set(moduleId, enabled)
      if (answer.module) {
        known = new Map(known).set(answer.module.id, answer.module)
        told()
      }
      return { ok: true }
    },
    refresh,
  }
}

const NO_STUDIO = 'This window has no Studio to switch modules on.'

let shared: StudioModuleSwitches | null = null

/**
 * The window's switches, over its own Studio connection, following it from
 * the first call: read at every open and every `module.changed`. Null in a
 * window whose Studio is another machine, whose switches are not this
 * window's to change.
 */
export function windowModuleSwitches(store: ModuleSwitchStore): StudioModuleSwitches | null {
  if (shared) return shared
  if (typeof window === 'undefined' || !window.api) return null
  const lifecycle = windowModuleLifecycle()
  if (!lifecycle) return null
  const switches = createStudioModuleSwitches({
    store,
    list: () => extensionsApi.listStudioModules(),
    setEnabled: async (moduleId, enabled) => {
      const answer = lifecycle ? await lifecycle.setEnabled(moduleId, enabled) : null
      return answer ?? { ok: false, message: NO_STUDIO }
    },
  })
  watchWindowStudio(window.api, () => {
    if (windowStudioState(window.api) === 'open') void switches.refresh()
  })
  extensionsApi.onThirdPartyModulesChanged(() => void switches.refresh())
  if (windowStudioState(window.api) === 'open') void switches.refresh()
  shared = switches
  return switches
}
