import type { ExtensionMount, ExtensionMountStudio } from '@sprintengine/extension-sdk'

const NAME = '{{displayName}}'

// A section in Settings, declared in extension.json
// (`contributes.settingsSections`, id "settings"). It saves the extension's
// Settings values through Studio (`settings.get`, `settings.set`, permission
// `settings:own`), which keeps them, so a worker reads the value with
// `studio.getModuleAppState('label')`.
export async function loadLabel(studio: ExtensionMountStudio): Promise<string> {
  const saved = await studio.host.call('settings.get', {})
  return typeof saved.label === 'string' ? saved.label : ''
}

/** Save the label; an empty one is cleared rather than kept as ''. */
export async function saveLabel(studio: ExtensionMountStudio, label: string): Promise<void> {
  await studio.host.call('settings.set', { key: 'label', value: label || null })
}

export const mount: ExtensionMount = async (root, studio) => {
  const document = root.ownerDocument
  const field = document.createElement('label')
  field.style.cssText = 'display: flex; flex-direction: column; gap: 4px; padding: 16px'
  const input = document.createElement('input')
  input.className = 'se-input'
  input.value = await loadLabel(studio)
  input.addEventListener('input', () => void saveLabel(studio, input.value))
  const hint = document.createElement('span')
  hint.className = 'se-muted'
  hint.textContent = `Shown wherever ${NAME} names itself.`
  field.append('Label', input, hint)
  root.append(field)
  studio.ready()
  return () => field.remove()
}
