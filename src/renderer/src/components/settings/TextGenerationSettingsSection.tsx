// Settings → Agents → Text generation: whether chat titles, commit messages
// and pull requests are drafted by the person's own agent CLI, which CLI,
// model and effort do the writing, and the style commit messages and pull
// requests are written in.
//
// The picker is the same control every launch surface uses, filtered to the
// CLIs that have a headless backend (TEXT_GENERATION_BACKENDS), so a person
// cannot pick a runtime that cannot answer. When no engine is chosen the row
// shows what will actually run — the first supported installed CLI at its
// cheap default — rather than an empty trigger, because that IS the choice
// in force. The copy names whose quota it spends: the honesty rule of
// the text-generation rule, the cost is theirs.
//
// The writing style is one value out of three, so a Select; the style guide
// field shows only under "My own instructions", because a field whose text is
// ignored in the mode on screen invites writing into nothing.

import { useCallback, useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'

import {
  resolveTextGenerationEngine,
  supportsTextGeneration,
  type TextGenerationEngine,
} from '../../../../shared/text-generation/contract'
import {
  MAX_WRITING_STYLE_INSTRUCTIONS_LENGTH,
  type WritingStyleMode,
} from '../../../../shared/text-generation/writing-style'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { AgentCli } from '../../../../shared/workspace'
import { CliModelPickerButton, Select, Textarea, type SelectItem } from '../ui'
import { selectAgentCliCatalog } from '../workspace/newWorkspace/cliRuntimeOptions'
import { SettingCard, SettingsRow, SettingsSectionTitle, SettingToggle } from './SettingsAtoms'
import { copy as appCopy } from '../../../../shared/copy'

const WRITING_STYLE_ITEMS: SelectItem<WritingStyleMode>[] = [
  { value: 'repository', label: appCopy.settings.textGenerationSettingsSection.matchTheRepository },
  { value: 'conventional', label: appCopy.settings.textGenerationSettingsSection.conventionalCommits },
  { value: 'custom', label: appCopy.settings.textGenerationSettingsSection.myOwnInstructions },
]

/** How long typing rests before the style guide is stored: the store, and main's copy of it, see words, not keys. */
const STYLE_GUIDE_COMMIT_DELAY_MS = 600

export function TextGenerationSettingsSection(): JSX.Element {
  const textGeneration = useWorkspaceStore((s) => s.appSettings.textGeneration)
  const setTextGenerationEnabled = useWorkspaceStore((s) => s.setTextGenerationEnabled)
  const setTextGenerationEngine = useWorkspaceStore((s) => s.setTextGenerationEngine)
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const cliModelCatalog = useWorkspaceStore((s) => s.appSettings.cliModelCatalog)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const pluginCatalogStatus = useWorkspaceStore((s) => s.pluginCatalogStatus)
  const cliAvailability = useWorkspaceStore((s) => s.cliAvailability)
  const cliAvailabilityStatus = useWorkspaceStore((s) => s.cliAvailabilityStatus)

  // Installed CLIs with a backend, in catalog order. Availability filtering
  // hides only an explicit not-installed, like every deployment picker.
  const options = useMemo(
    () =>
      selectAgentCliCatalog(
        pluginCatalogStatus,
        pluginCatalogEntries,
        cliRuntimes,
        { map: cliAvailability, status: cliAvailabilityStatus },
        cliModelCatalog,
      ).filter((option) => supportsTextGeneration(option.value)),
    [pluginCatalogStatus, pluginCatalogEntries, cliRuntimes, cliAvailability, cliAvailabilityStatus, cliModelCatalog],
  )

  // What a title request made right now would run on: the stored choice when
  // its CLI is here, else the first supported installed CLI at its default.
  const effective = useMemo<TextGenerationEngine | null>(
    () =>
      resolveTextGenerationEngine(
        { ...textGeneration, enabled: true },
        options.map((option) => option.value),
        (cli) => cliAvailability?.[cli]?.installed,
      ),
    [textGeneration, options, cliAvailability],
  )

  const stored = textGeneration.engine
  const noRuntime = options.length === 0

  const modelFor = (cli: AgentCli): string | undefined => {
    if (stored?.cli === cli) return stored.model || effective?.model
    return effective?.cli === cli ? effective.model : undefined
  }
  const reasoningFor = (cli: AgentCli): string | undefined => {
    if (stored?.cli === cli) return stored.reasoning ?? effective?.reasoning
    return effective?.cli === cli ? effective.reasoning : undefined
  }

  return (
    // No top rule on the section: the card draws its own edge.
    <section className="space-y-3 pt-2">
      <SettingsSectionTitle>{appCopy.settings.textGenerationSettingsSection.textGeneration}</SettingsSectionTitle>
      <SettingCard>
        <SettingToggle
          label={appCopy.settings.textGenerationSettingsSection.nameChatsWithYourAgent}
          enabled={textGeneration.enabled}
          onChange={setTextGenerationEnabled}
          requirement={noRuntime ? 'Needs Claude Code or Codex' : undefined}
        />
        <SettingsRow label={appCopy.settings.textGenerationSettingsSection.textGenerationModel}>
          {noRuntime || !effective ? (
            <span className="text-body text-[color:var(--text-muted)]">
              {appCopy.settings.textGenerationSettingsSection.noSupportedCLIInstalled}
            </span>
          ) : (
            <CliModelPickerButton
              ariaLabel={appCopy.settings.textGenerationSettingsSection.textGenerationModel}
              options={options}
              cli={effective.cli}
              disabled={!textGeneration.enabled}
              effectiveModelFor={modelFor}
              effectiveReasoningFor={reasoningFor}
              onSelectReasoning={(cli, reasoning) =>
                // An empty level is an explicit clear; leaving it undefined
                // would tell the setter to keep the stored one.
                setTextGenerationEngine({ cli, model: modelFor(cli) ?? '', reasoning: reasoning ?? '' })
              }
              onSelectCli={(cli) => setTextGenerationEngine({ cli, model: '' })}
              onSelectModel={(cli, model) => setTextGenerationEngine({ cli, model: model ?? '' })}
            />
          )}
        </SettingsRow>
        <WritingStyleRows disabled={!textGeneration.enabled} />
      </SettingCard>
    </section>
  )
}

function WritingStyleRows({ disabled }: { disabled: boolean }): JSX.Element {
  const writingStyle = useWorkspaceStore((s) => s.appSettings.textGeneration.writingStyle)
  const setWritingStyle = useWorkspaceStore((s) => s.setTextGenerationWritingStyle)
  const guideId = useId()
  const styleId = useId()
  // Held here while it is typed and stored when typing rests or the field is
  // left: every stored change is also pushed to main's copy of the setting.
  const [guide, setGuide] = useState(writingStyle.instructions)
  const pending = useRef<{ text: string; timer: ReturnType<typeof setTimeout> | null }>({
    text: writingStyle.instructions,
    timer: null,
  })
  const commitGuide = useCallback(() => {
    const current = pending.current
    if (current.timer !== null) {
      clearTimeout(current.timer)
      current.timer = null
    }
    if (current.text !== useWorkspaceStore.getState().appSettings.textGeneration.writingStyle.instructions) {
      setWritingStyle({ instructions: current.text })
    }
  }, [setWritingStyle])
  useEffect(() => commitGuide, [commitGuide])
  // Another window (or an import) changed the stored guide while this field
  // was not being typed in: show what is stored.
  useEffect(() => {
    if (pending.current.timer !== null) return
    pending.current.text = writingStyle.instructions
    setGuide(writingStyle.instructions)
  }, [writingStyle.instructions])

  return (
    <>
      <SettingsRow label={appCopy.settings.textGenerationSettingsSection.commitAndPullRequestStyle} htmlFor={styleId}>
        <Select
          id={styleId}
          ariaLabel={appCopy.settings.textGenerationSettingsSection.commitAndPullRequestStyle}
          items={WRITING_STYLE_ITEMS}
          value={writingStyle.mode}
          onChange={(mode) => setWritingStyle({ mode })}
          disabled={disabled}
        />
      </SettingsRow>
      {writingStyle.mode === 'custom' ? (
        <SettingsRow label={appCopy.settings.textGenerationSettingsSection.yourStyleGuide} htmlFor={guideId} stacked>
          <Textarea
            id={guideId}
            value={guide}
            maxLength={MAX_WRITING_STYLE_INSTRUCTIONS_LENGTH}
            disabled={disabled}
            onChange={(event) => {
              const text = event.target.value.slice(0, MAX_WRITING_STYLE_INSTRUCTIONS_LENGTH)
              setGuide(text)
              pending.current.text = text
              if (pending.current.timer !== null) clearTimeout(pending.current.timer)
              pending.current.timer = setTimeout(commitGuide, STYLE_GUIDE_COMMIT_DELAY_MS)
            }}
            onBlur={commitGuide}
            placeholder={appCopy.settings.textGenerationSettingsSection.eGPastTenseSubject}
            size="md"
            variant="well"
            rows={4}
          />
        </SettingsRow>
      ) : null}
    </>
  )
}
