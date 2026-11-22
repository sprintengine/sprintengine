import { useEffect, useId, useState, type ReactElement } from 'react'

import type {
  ExtensionSettingContribution,
  ExtensionSettingValue,
} from '../../../../shared/modules/third-party-manifest'
import { extensionsApi } from '../../studio/extensions'
import { showToast } from '../../store/toastStore'
import { EmptyState, GhostButton, Input, Select, SettingCard, SettingRow, Switch, Textarea } from '../ui'

// The settings an extension declares in extension.json, drawn by Studio as
// its own rows: no extension code runs for them. Each value lives on the
// window's Studio (`extension.settings`, `extension.setSetting`), held there to
// what the extension declares of it, so every client shows the same value and
// the extension's own code reads it (`settings.get` in a frame,
// `getModuleAppState` in a worker). A setting the person never set shows, and
// reads as, its default.
//
// The form follows the values: a change from another window, another client
// or the extension's own code is heard (`extension.settingsChanged`) and read
// again, and so is everything after a reconnect. Reading and changing them
// both need `settings:write`, as Studio's own settings do; a connection
// without it sees the declared settings, read only, with their defaults.

type Values = Record<string, ExtensionSettingValue>
type State =
  { status: 'loading' } | { status: 'failed'; message: string } | { status: 'ready'; values: Values; writable: boolean }

/** What each setting shows on a connection that may not read the values: its default. */
function defaultsOf(settings: readonly ExtensionSettingContribution[]): Values {
  const values: Values = {}
  for (const setting of settings) if (setting.default !== undefined) values[setting.key] = setting.default
  return values
}

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
    const read = async () => {
      try {
        const writable = await extensionsApi.canChangeExtensionSettings()
        const values = writable ? await extensionsApi.extensionSettings(extensionKey) : defaultsOf(settings)
        if (current) setState({ status: 'ready', values, writable })
      } catch (error) {
        if (current) setState({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
      }
    }
    void read()
    const stop = extensionsApi.onExtensionSettingsChanged((moduleId) => {
      if (moduleId === null || moduleId === extensionKey) void read()
    })
    return () => {
      current = false
      stop()
    }
  }, [extensionKey, settings])

  if (state.status === 'failed') return <EmptyState title="These settings could not be read" body={state.message} />
  if (state.status === 'loading') return <SettingCard aria-busy="true">{null}</SettingCard>

  const save = async (setting: ExtensionSettingContribution, value: ExtensionSettingValue | null): Promise<boolean> => {
    const answer = await extensionsApi.setExtensionSetting({ moduleId: extensionKey, key: setting.key, value })
    if (answer.ok) setState({ status: 'ready', values: answer.values, writable: true })
    else showToast({ tone: 'warn', title: `${setting.title} was not changed`, description: answer.message })
    return answer.ok
  }
  return (
    <SettingCard>
      {state.writable ? null : (
        <p className="px-4 pt-3 text-meta text-[color:var(--text-muted)]">
          Read only here: this connection may not read or change Studio’s settings, so each shows its default.
        </p>
      )}
      {settings.map((setting) => (
        <SettingField
          key={setting.key}
          setting={setting}
          value={state.values[setting.key]}
          readOnly={!state.writable}
          onSave={(value) => save(setting, value)}
        />
      ))}
    </SettingCard>
  )
}

function SettingField({
  setting,
  value,
  readOnly,
  onSave,
}: {
  setting: ExtensionSettingContribution
  value: ExtensionSettingValue | undefined
  readOnly: boolean
  onSave: (value: ExtensionSettingValue | null) => Promise<boolean>
}): ReactElement {
  const labelId = useId()
  const helpId = setting.description ? `${labelId}-help` : undefined
  // Back to its default: what an emptied field never means, since an empty
  // string is a value a setting may hold.
  const resettable = !readOnly && value !== undefined && value !== setting.default
  const row = (control: ReactElement, stacked = false) => (
    <SettingRow label={setting.title} help={setting.description} labelId={labelId} helpId={helpId} stacked={stacked}>
      <div className="flex items-center gap-2">
        {control}
        {resettable ? (
          <GhostButton size="sm" aria-label={`Reset ${setting.title} to default`} onClick={() => void onSave(null)}>
            Reset to default
          </GhostButton>
        ) : null}
      </div>
    </SettingRow>
  )
  if (setting.type === 'boolean')
    return row(
      <Switch
        checked={value === true}
        disabled={readOnly}
        onChange={(next) => void onSave(next)}
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
        onChange={(index) => void onSave(choices[Number(index)]!)}
        disabled={readOnly}
        size="sm"
        {...(setting.placeholder ? { placeholder: setting.placeholder } : {})}
      />,
    )
  }
  return row(
    <TextField setting={setting} value={value} onSave={onSave} labelId={labelId} readOnly={readOnly} />,
    setting.multiline === true,
  )
}

/**
 * Text or a number, saved when the field is left or Enter is pressed. Text is
 * saved as typed, empty included; an emptied number goes back to its default,
 * as "Reset to default" does for any setting. A value the Studio refuses puts
 * the field back to what is kept.
 */
function TextField({
  setting,
  value,
  onSave,
  labelId,
  readOnly,
}: {
  setting: ExtensionSettingContribution
  value: ExtensionSettingValue | undefined
  onSave: (value: ExtensionSettingValue | null) => Promise<boolean>
  labelId: string
  readOnly: boolean
}): ReactElement {
  const shown = value === undefined ? '' : String(value)
  const [draft, setDraft] = useState(shown)
  useEffect(() => setDraft(shown), [shown])
  const numeric = setting.type === 'number' || setting.type === 'integer'
  const commit = () => {
    if (draft === shown) return
    const number = Number(draft)
    if (numeric && draft.trim() !== '' && !Number.isFinite(number)) {
      setDraft(shown)
      return
    }
    const value = draftValue(setting, draft)
    void onSave(value).then((saved) => {
      if (!saved) setDraft(shown)
    })
  }
  const shared = {
    'aria-labelledby': labelId,
    readOnly,
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

/** What a field's draft saves as: text as it is typed, an empty one included; an emptied number, its default (`null`). */
export function draftValue(setting: ExtensionSettingContribution, draft: string): ExtensionSettingValue | null {
  const numeric = setting.type === 'number' || setting.type === 'integer'
  if (!numeric) return draft
  return draft.trim() === '' ? null : Number(draft)
}
