import { useEffect, useId, useState, type ReactElement } from 'react'

import type {
  ExtensionSettingContribution,
  ExtensionSettingValue,
} from '../../../../shared/modules/third-party-manifest'
import { extensionsApi } from '../../studio/extensions'
import { showToast } from '../../store/toastStore'
import { EmptyState, Input, Select, SettingCard, SettingRow, Switch, Textarea } from '../ui'

// The settings an extension declares in extension.json, drawn by Studio as
// its own rows: no extension code runs for them. Each value lives on the
// window's Studio (`extension.settings`, `extension.setSetting`), held there to
// what the extension declares of it, so every client shows the same value and
// the extension's own code reads it (`settings.get` in a frame,
// `getModuleAppState` in a worker). A setting the person never set shows, and
// reads as, its default.

type Values = Record<string, ExtensionSettingValue>
type State = { status: 'loading' } | { status: 'failed'; message: string } | { status: 'ready'; values: Values }

export function ExtensionSettingsForm({
  extensionKey,
  settings,
}: {
  extensionKey: string
  settings: readonly ExtensionSettingContribution[]
}): ReactElement {
  const [state, setState] = useState<State>({ status: 'loading' })
  useEffect(() => {
    let current = true
    extensionsApi.extensionSettings(extensionKey).then(
      (values) => current && setState({ status: 'ready', values }),
      (error: unknown) =>
        current && setState({ status: 'failed', message: error instanceof Error ? error.message : String(error) }),
    )
    return () => {
      current = false
    }
  }, [extensionKey])

  if (state.status === 'failed') return <EmptyState title="These settings could not be read" body={state.message} />
  if (state.status === 'loading') return <SettingCard aria-busy="true">{null}</SettingCard>

  const save = async (setting: ExtensionSettingContribution, value: ExtensionSettingValue | null) => {
    const answer = await extensionsApi.setExtensionSetting({ moduleId: extensionKey, key: setting.key, value })
    if (answer.ok) setState({ status: 'ready', values: answer.values })
    else showToast({ tone: 'warn', title: `${setting.title} was not changed`, description: answer.message })
  }
  return (
    <SettingCard>
      {settings.map((setting) => (
        <SettingField
          key={setting.key}
          setting={setting}
          value={state.values[setting.key]}
          onSave={(value) => void save(setting, value)}
        />
      ))}
    </SettingCard>
  )
}

function SettingField({
  setting,
  value,
  onSave,
}: {
  setting: ExtensionSettingContribution
  value: ExtensionSettingValue | undefined
  onSave: (value: ExtensionSettingValue | null) => void
}): ReactElement {
  const labelId = useId()
  const helpId = setting.description ? `${labelId}-help` : undefined
  const row = (control: ReactElement, stacked = false) => (
    <SettingRow label={setting.title} help={setting.description} labelId={labelId} helpId={helpId} stacked={stacked}>
      {control}
    </SettingRow>
  )
  if (setting.type === 'boolean')
    return row(
      <Switch
        checked={value === true}
        onChange={(next) => onSave(next)}
        ariaLabelledBy={labelId}
        ariaDescribedBy={helpId}
      />,
    )
  if (setting.enum) {
    const choices = setting.enum
    const selected = choices.findIndex((choice) => choice === value)
    return row(
      <Select
        ariaLabel={setting.title}
        items={choices.map((choice, index) => ({
          value: String(index),
          label: setting.enumLabels?.[index] ?? String(choice),
        }))}
        value={selected === -1 ? null : String(selected)}
        onChange={(index) => onSave(choices[Number(index)]!)}
        size="sm"
        {...(setting.placeholder ? { placeholder: setting.placeholder } : {})}
      />,
    )
  }
  return row(
    <TextField setting={setting} value={value} onSave={onSave} labelId={labelId} />,
    setting.multiline === true,
  )
}

/** Text or a number, saved when the field is left or Enter is pressed; emptied, it goes back to its default. */
function TextField({
  setting,
  value,
  onSave,
  labelId,
}: {
  setting: ExtensionSettingContribution
  value: ExtensionSettingValue | undefined
  onSave: (value: ExtensionSettingValue | null) => void
  labelId: string
}): ReactElement {
  const shown = value === undefined ? '' : String(value)
  const [draft, setDraft] = useState(shown)
  useEffect(() => setDraft(shown), [shown])
  const numeric = setting.type === 'number' || setting.type === 'integer'
  const commit = () => {
    if (draft === shown) return
    if (draft.trim() === '' && numeric) return onSave(null)
    if (!numeric) return onSave(draft)
    const number = Number(draft)
    if (!Number.isFinite(number)) {
      setDraft(shown)
      return
    }
    onSave(number)
  }
  const shared = {
    'aria-labelledby': labelId,
    value: draft,
    placeholder: setting.placeholder,
    onBlur: commit,
  }
  if (setting.multiline)
    return (
      <Textarea
        {...shared}
        rows={3}
        maxLength={setting.maxLength ?? 4096}
        onChange={(event) => setDraft(event.currentTarget.value)}
      />
    )
  return (
    <Input
      {...shared}
      size="sm"
      type={numeric ? 'number' : 'text'}
      {...(numeric
        ? {
            ...(setting.minimum !== undefined ? { min: setting.minimum } : {}),
            ...(setting.maximum !== undefined ? { max: setting.maximum } : {}),
            step: setting.type === 'integer' ? 1 : 'any',
          }
        : { maxLength: setting.maxLength ?? 4096 })}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
      }}
    />
  )
}
