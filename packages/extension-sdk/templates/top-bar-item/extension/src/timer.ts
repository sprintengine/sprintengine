import type { ExtensionMount, ExtensionMountStudio } from '@sprintengine/extension-sdk'

// The door the top bar button opens. extension.json declares both: the button
// (`contributes.topBarItems`, with `door: "timer"`) and the door
// (`contributes.doors`). Studio draws the button with the declared icon and
// title; this file draws the door, in a frame of its own.

const ENDS_AT_KEY = 'focusEndsAt'
export const FOCUS_MINUTES = 25

export function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** What the door shows for a timer ending at `endsAt` (null: none running), at `now`. */
export function timerView(endsAt: number | null, now: number): { time: string; action: string } {
  if (endsAt === null) {
    return { time: formatRemaining(FOCUS_MINUTES * 60_000), action: `Start ${FOCUS_MINUTES} minutes of focus` }
  }
  return endsAt <= now
    ? { time: 'Time is up', action: 'Clear the timer' }
    : { time: formatRemaining(endsAt - now), action: 'Stop the timer' }
}

// The end time is one of the extension's Settings values, which Studio keeps
// (`settings.set`, permission `settings:own`), so a running timer survives a
// restart.
export async function readEndsAt(studio: ExtensionMountStudio): Promise<number | null> {
  const saved = (await studio.host.call('settings.get', {}))[ENDS_AT_KEY]
  return typeof saved === 'number' ? saved : null
}

export async function saveEndsAt(studio: ExtensionMountStudio, endsAt: number | null): Promise<void> {
  await studio.host.call('settings.set', { key: ENDS_AT_KEY, value: endsAt })
}

export const mount: ExtensionMount = async (root, studio) => {
  const document = root.ownerDocument
  let endsAt = await readEndsAt(studio)

  const view = document.createElement('div')
  view.style.cssText =
    'display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; height: 100%'
  const time = document.createElement('p')
  time.style.cssText = 'margin: 0; font-size: 48px; font-variant-numeric: tabular-nums'
  time.setAttribute('aria-live', 'polite')
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'se-button se-button--primary'
  view.append(time, button)
  root.append(view)

  const draw = () => {
    const shown = timerView(endsAt, Date.now())
    time.textContent = shown.time
    button.textContent = shown.action
  }
  button.addEventListener('click', () => {
    endsAt = endsAt === null ? Date.now() + FOCUS_MINUTES * 60_000 : null
    draw()
    void saveEndsAt(studio, endsAt)
  })
  const ticking = window.setInterval(draw, 1000)

  draw()
  studio.ready()
  return () => {
    window.clearInterval(ticking)
    view.remove()
  }
}
