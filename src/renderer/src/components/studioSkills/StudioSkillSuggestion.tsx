import { useState, type JSX } from 'react'

import {
  shouldSuggestStudioAreaSkill,
  studioAreaSkill,
  type StudioAreaSkillId,
} from '../../../../shared/studio-area-skills'
import {
  dismissStudioAreaSkill,
  setStudioAreaSkillEnabled,
  useStudioAreaSkillChoices,
} from '../../store/studioAreaSkillsStore'
import { LinkButton } from '../ui'
import { copy } from '../../../../shared/copy'

/**
 * A surface offering its own Studio skill, in one line at the top of the
 * surface: what the skill teaches agents, Install, and Not now.
 *
 * Copy, not a notice. The system has no info tone on purpose ("information is
 * content" — design-system/components/inline-notice), and an offer is not a
 * failure or a degraded state, so it takes no tint, no glyph and no card: muted
 * type and two links, which is as quiet as the surface can say it.
 *
 * Shown until the person answers, then never again. Install switches it on
 * for every workspace (shared/studio-area-skills.ts); Not now records the
 * answer, and the skill stays a switch in Settings either way. Nothing renders
 * before main has said what the person already chose.
 */
export function StudioSkillSuggestion({
  skillId,
  className,
}: {
  skillId: StudioAreaSkillId
  className?: string
}): JSX.Element | null {
  const choices = useStudioAreaSkillChoices()
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  if (!choices || !shouldSuggestStudioAreaSkill(choices, skillId)) return null
  const skill = studioAreaSkill(skillId)

  const answer = (run: () => Promise<void>) => {
    setPending(true)
    setFailed(false)
    run()
      .catch(() => setFailed(true))
      .finally(() => setPending(false))
  }

  return (
    <div
      aria-label={copy.studioSkills.studioSkillSuggestion.skillForAgents(skill.name)}
      role="group"
      className={[
        'flex flex-wrap items-baseline gap-x-3 gap-y-1 text-meta text-[color:var(--text-muted)]',
        className ?? '',
      ].join(' ')}
    >
      <span className="min-w-0">
        {skill.gives}
        {copy.studioSkills.studioSkillSuggestion.installThe}
        {skill.name}
        {copy.studioSkills.studioSkillSuggestion.skillForEveryWorkspaceOr}
      </span>
      <span className="flex shrink-0 items-baseline gap-3">
        <LinkButton disabled={pending} onClick={() => answer(() => setStudioAreaSkillEnabled(skillId, true))}>
          {copy.studioSkills.studioSkillSuggestion.install}
        </LinkButton>
        <LinkButton ink="quiet" disabled={pending} onClick={() => answer(() => dismissStudioAreaSkill(skillId))}>
          {copy.studioSkills.studioSkillSuggestion.notNow}
        </LinkButton>
      </span>
      {failed ? <span className="w-full">{copy.studioSkills.studioSkillSuggestion.didnTSaveTryAgain}</span> : null}
    </div>
  )
}
