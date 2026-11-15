// The person's choices about the built-in plugin's area skills, as every
// surface in this window reads them: one fetch, then the Studio's pushes
// (`areaSkills.get`, `areaSkills.changed`).
//
// A surface's suggestion and the Settings switch read the same record, so
// installing from the Backlog panel flips the switch, and switching one off in
// Settings brings the suggestion back only if it was never turned down.
//
// Until the first answer arrives the record is `null`, and a surface shows no
// suggestion — offering one that the person already accepted, for the half
// second before main answers, is the nag this whole change exists to stop.

import { useSyncExternalStore } from 'react'

import {
  normaliseStudioAreaSkillChoices,
  type StudioAreaSkillChoices,
  type StudioAreaSkillId,
} from '../../../shared/studio-area-skills'
import { agentSetupApi, windowHasStudio, type AgentSetupApi } from '../studio/agentSetup'

let choices: StudioAreaSkillChoices | null = null
let started = false
const listeners = new Set<() => void>()

function publish(next: unknown): void {
  choices = normaliseStudioAreaSkillChoices(next)
  for (const listener of listeners) listener()
}

function api(): AgentSetupApi | undefined {
  return windowHasStudio() ? agentSetupApi : undefined
}

function start(): void {
  if (started) return
  started = true
  const bridge = api()
  // A page with no Studio: no choices, so no suggestion and a Settings
  // section with nothing to show.
  if (!bridge) return
  bridge.onStudioAreaSkillsChanged((next) => publish(next))
  void bridge
    .studioAreaSkillsGet()
    .then(publish)
    .catch(() => undefined)
}

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The record, or null until main has answered. */
export function useStudioAreaSkillChoices(): StudioAreaSkillChoices | null {
  return useSyncExternalStore(subscribe, () => choices)
}

export async function setStudioAreaSkillEnabled(skillId: StudioAreaSkillId, enabled: boolean): Promise<void> {
  const bridge = api()
  if (!bridge) return
  publish(await bridge.studioAreaSkillsSetEnabled({ skillId, enabled }))
}

export async function dismissStudioAreaSkill(skillId: StudioAreaSkillId): Promise<void> {
  const bridge = api()
  if (!bridge) return
  publish(await bridge.studioAreaSkillsDismiss({ skillId }))
}

/** Tests only: forget the record and the subscription. */
export function resetStudioAreaSkillsStoreForTests(): void {
  choices = null
  started = false
  listeners.clear()
}
