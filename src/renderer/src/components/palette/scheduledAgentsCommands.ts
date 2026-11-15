// The command palette's rows for pausing scheduled agents: every one at once
// (for an hour, until tomorrow morning, until resumed) or each on its own, and
// resuming either. One row per thing that can be done now — a paused schedule
// offers Resume and not Pause — so the palette never lists a verb that would
// do nothing.
//
// Store-free: the palette hands over the list, the pause and the calls, so the
// rows are testable without a window.

import {
  scheduledAgentTitle,
  type ScheduledAgentView,
  type ScheduledAgentsPause,
} from '../../../../shared/scheduled-agents'
import { pauseAllChoices, scheduledAgentsPauseWords, type PauseAllChoice } from '../../utils/scheduledAgentsPause'
import type { PaletteCommand } from './paletteProvider'
import { copy } from '../../../../shared/copy'

export type ScheduledAgentsPaletteActions = {
  pauseAll: (choice: PauseAllChoice) => void
  resumeAll: () => void
  setPaused: (agent: ScheduledAgentView, paused: boolean) => void
}

const KEYWORDS = 'scheduled agents schedules cron recurring stop hold suspend'

export function scheduledAgentPaletteCommands(
  agents: readonly ScheduledAgentView[],
  pause: ScheduledAgentsPause | null,
  now: number,
  actions: ScheduledAgentsPaletteActions,
): Omit<PaletteCommand, 'group'>[] {
  if (agents.length === 0) return []
  const all: Omit<PaletteCommand, 'group'>[] = pause
    ? [
        {
          id: 'scheduled-agents.resume-all',
          label: copy.palette.scheduledAgentsCommands.resumeScheduledAgents,
          description: scheduledAgentsPauseWords(pause, now),
          keywords: `${KEYWORDS} unpause resume all`,
          run: actions.resumeAll,
        },
      ]
    : pauseAllChoices(now).map((choice) => ({
        id: `scheduled-agents.pause-all.${choice.id}`,
        // "… for 1 hour", "… until tomorrow morning", "… until I resume them".
        label: copy.palette.scheduledAgentsCommands.pauseAllScheduledAgents(
          choice.label.charAt(0).toLowerCase(),
          choice.label.slice(1),
        ),
        searchLabel: copy.palette.scheduledAgentsCommands.pauseAllScheduledAgents2,
        description: choice.hint
          ? copy.palette.scheduledAgentsCommands.untilRunsAlreadyGoingCarry(choice.hint)
          : copy.palette.scheduledAgentsCommands.runsAlreadyGoingCarryOn,
        keywords: `${KEYWORDS} pause all`,
        run: () => actions.pauseAll(choice),
      }))
  const each = agents.map((agent) => {
    const title = scheduledAgentTitle(agent.prompt, agent.name)
    const paused = agent.pausedAt !== undefined
    return {
      id: `scheduled-agents.${paused ? 'resume' : 'pause'}.${agent.id}`,
      label: copy.palette.scheduledAgentsCommands.schedule(
        paused ? copy.palette.scheduledAgentsCommands.resume : copy.palette.scheduledAgentsCommands.pause,
        title,
      ),
      searchLabel: title,
      description: paused
        ? copy.palette.scheduledAgentsCommands.runsNextAtItsNext
        : copy.palette.scheduledAgentsCommands.noRunsAtItsTimes,
      keywords: `${KEYWORDS} ${paused ? 'resume unpause' : 'pause'}`,
      run: () => actions.setPaused(agent, !paused),
    }
  })
  return [...all, ...each]
}
