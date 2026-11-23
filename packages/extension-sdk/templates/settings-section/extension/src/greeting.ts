import type { ExtensionMount, ExtensionMountStudio } from '@sprintengine/extension-sdk'

// A section in Settings, declared in extension.json
// (`contributes.settingsSections`), drawn in a frame of its own. What it saves
// Studio keeps as the extension's Settings values (`settings.set`, permission
// `settings:own`), and a worker reads them with `getModuleAppState`. The
// declared command "Open settings" runs Studio's own `app.settings.open`,
// with no code here at all.

type Tone = 'plain' | 'warm'

export type GreetingValues = { name?: unknown; tone?: unknown }

const TONES: Array<[Tone, string]> = [
  ['plain', 'Plain'],
  ['warm', 'Warm'],
]

const asTone = (value: unknown): Tone => (value === 'warm' ? 'warm' : 'plain')

export function greetingFrom(values: GreetingValues): string {
  const name = typeof values.name === 'string' && values.name.trim() ? values.name.trim() : 'there'
  return asTone(values.tone) === 'warm' ? `Good to see you, ${name}!` : `Hello, ${name}.`
}

/** Save one value; an empty one is cleared rather than kept as ''. */
export async function saveGreeting(studio: ExtensionMountStudio, key: 'name' | 'tone', value: string): Promise<void> {
  await studio.host.call('settings.set', { key, value: value || null })
}

export const mount: ExtensionMount = async (root, studio) => {
  const document = root.ownerDocument
  const values: GreetingValues = await studio.host.call('settings.get', {})

  const form = document.createElement('div')
  form.style.cssText = 'display: flex; flex-direction: column; gap: 12px; padding: 16px'
  const preview = document.createElement('p')
  preview.className = 'se-muted'
  preview.style.margin = '0'
  const showPreview = () => (preview.textContent = `Preview: ${greetingFrom(values)}`)

  const nameLabel = document.createElement('label')
  nameLabel.style.cssText = 'display: flex; flex-direction: column; gap: 4px'
  const name = document.createElement('input')
  name.className = 'se-input'
  name.value = typeof values.name === 'string' ? values.name : ''
  name.addEventListener('input', () => {
    values.name = name.value
    showPreview()
    void saveGreeting(studio, 'name', name.value)
  })
  nameLabel.append('Your name', name)

  const tones = document.createElement('fieldset')
  tones.style.cssText = 'border: none; margin: 0; padding: 0'
  const legend = document.createElement('legend')
  legend.textContent = 'Tone'
  tones.append(legend)
  for (const [tone, label] of TONES) {
    const option = document.createElement('label')
    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = 'tone'
    radio.checked = asTone(values.tone) === tone
    radio.addEventListener('change', () => {
      values.tone = tone
      showPreview()
      void saveGreeting(studio, 'tone', tone)
    })
    option.append(radio, ` ${label}`)
    tones.append(option)
  }

  showPreview()
  form.append(nameLabel, tones, preview)
  root.append(form)
  studio.ready()
  return () => form.remove()
}
