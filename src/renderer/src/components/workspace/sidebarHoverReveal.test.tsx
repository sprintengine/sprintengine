// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import {
  SIDEBAR_REVEAL_CLOSE_DELAY_MS,
  SIDEBAR_REVEAL_OPEN_DELAY_MS,
  SIDEBAR_REVEAL_SWEEP_PX,
  SidebarRevealFrame,
  SidebarRevealZones,
  sidebarRevealHeld,
  useSidebarHoverReveal,
  type SidebarHoverReveal,
} from './sidebarHoverReveal'

type Props = { enabled: boolean; dismissKey: string }

let host: HTMLDivElement
let root: Root
let reveal: SidebarHoverReveal

function Shell({ enabled, dismissKey }: Props) {
  reveal = useSidebarHoverReveal({ enabled, dismissKey })
  return (
    <div data-testid="region" {...reveal.regionProps}>
      <SidebarRevealZones reveal={reveal} />
      <SidebarRevealFrame reveal={reveal}>
        <aside aria-label="Workspaces">
          <input aria-label="Rename" />
          <button type="button" aria-haspopup="menu" aria-expanded="false">
            More
          </button>
        </aside>
      </SidebarRevealFrame>
    </div>
  )
}

async function render(props: Props) {
  await act(async () => root.render(<Shell {...props} />))
}

// The handlers take the fields they read; a hovering mouse with no button down.
const mouse = (clientY = 200) => ({ pointerType: 'mouse', buttons: 0, clientY }) as unknown as React.PointerEvent

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

async function restAtEdge(clientY = 200) {
  act(() => reveal.zoneProps.onPointerEnter(mouse(clientY)))
  await advance(SIDEBAR_REVEAL_OPEN_DELAY_MS)
  // The two frames the slide starts from.
  await advance(40)
}

async function leaveRegion() {
  act(() => {
    reveal.zoneProps.onPointerLeave()
    reveal.regionProps.onPointerLeave()
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'],
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

test('resting the pointer at the edge shows the sidebar after the open delay', async () => {
  await render({ enabled: true, dismissKey: 'a' })
  expect(host.querySelectorAll('[data-sidebar-reveal-zone]')).toHaveLength(2)
  act(() => reveal.zoneProps.onPointerEnter(mouse()))
  await advance(SIDEBAR_REVEAL_OPEN_DELAY_MS - 1)
  expect(reveal.phase).toBe('closed')
  await advance(41)
  expect(reveal.phase).toBe('open')
  expect(host.querySelector('[data-reveal="open"]')).not.toBeNull()
})

test('a pointer sweeping past the edge does not call it', async () => {
  await render({ enabled: true, dismissKey: 'a' })
  act(() => reveal.zoneProps.onPointerEnter(mouse()))
  await advance(SIDEBAR_REVEAL_OPEN_DELAY_MS / 2)
  act(() => reveal.zoneProps.onPointerLeave())
  await advance(SIDEBAR_REVEAL_OPEN_DELAY_MS * 2)
  expect(reveal.phase).toBe('closed')
})

test('running along the edge restarts the delay, so the way to the traffic lights opens nothing', async () => {
  await render({ enabled: true, dismissKey: 'a' })
  act(() => reveal.zoneProps.onPointerEnter(mouse(400)))
  let y = 400
  for (let step = 0; step < 6; step += 1) {
    await advance(SIDEBAR_REVEAL_OPEN_DELAY_MS - 50)
    y -= SIDEBAR_REVEAL_SWEEP_PX + 1
    act(() => reveal.zoneProps.onPointerMove(mouse(y)))
  }
  expect(reveal.phase).toBe('closed')
  // A small wobble while resting does not.
  act(() => reveal.zoneProps.onPointerMove(mouse(y + 3)))
  await advance(SIDEBAR_REVEAL_OPEN_DELAY_MS + 40)
  expect(reveal.phase).toBe('open')
})

test('a finger or a pointer with a button down is not reaching for it', async () => {
  await render({ enabled: true, dismissKey: 'a' })
  act(() => reveal.zoneProps.onPointerEnter({ pointerType: 'touch', buttons: 0, clientY: 0 } as React.PointerEvent))
  act(() => reveal.zoneProps.onPointerEnter({ pointerType: 'mouse', buttons: 1, clientY: 0 } as React.PointerEvent))
  await advance(SIDEBAR_REVEAL_OPEN_DELAY_MS * 2)
  expect(reveal.phase).toBe('closed')
})

test('leaving the rail and the sidebar puts it away after the close delay, and coming back keeps it', async () => {
  await render({ enabled: true, dismissKey: 'a' })
  await restAtEdge()
  await leaveRegion()
  await advance(SIDEBAR_REVEAL_CLOSE_DELAY_MS - 1)
  act(() => reveal.regionProps.onPointerEnter())
  await advance(SIDEBAR_REVEAL_CLOSE_DELAY_MS * 2)
  expect(reveal.phase).toBe('open')

  await leaveRegion()
  await advance(SIDEBAR_REVEAL_CLOSE_DELAY_MS)
  expect(reveal.phase).toBe('closing')
  // The slide's end puts it away; the fallback covers one that never reports.
  await advance(400)
  expect(reveal.phase).toBe('closed')
  expect(host.querySelector('[data-reveal]')).toBeNull()
})

test('Escape puts it away and goes no further, unless a menu stands over it', async () => {
  await render({ enabled: true, dismissKey: 'a' })
  await restAtEdge()
  const below = vi.fn()
  document.addEventListener('keydown', below)

  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  document.body.append(menu)
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  expect(reveal.phase).toBe('open')
  expect(below).toHaveBeenCalledTimes(1)
  menu.remove()

  const press = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  act(() => {
    document.body.dispatchEvent(press)
  })
  expect(reveal.phase).toBe('closing')
  expect(press.defaultPrevented).toBe(true)
  expect(below).toHaveBeenCalledTimes(1)
  document.removeEventListener('keydown', below)
})

test('going somewhere from it puts it away', async () => {
  await render({ enabled: true, dismissKey: 'a' })
  await restAtEdge()
  await render({ enabled: true, dismissKey: 'b' })
  expect(reveal.phase).toBe('closing')
})

test('docking the sidebar, or turning the setting off, ends it at once and takes the strips away', async () => {
  await render({ enabled: true, dismissKey: 'a' })
  await restAtEdge()
  await render({ enabled: false, dismissKey: 'a' })
  expect(reveal.phase).toBe('closed')
  expect(host.querySelectorAll('[data-sidebar-reveal-zone]')).toHaveLength(0)
  act(() => reveal.zoneProps.onPointerEnter(mouse()))
  await advance(SIDEBAR_REVEAL_OPEN_DELAY_MS * 2)
  expect(reveal.phase).toBe('closed')
})

test('it stays out while a menu opened from it is up, and goes once the menu does', async () => {
  await render({ enabled: true, dismissKey: 'a' })
  await restAtEdge()
  const trigger = host.querySelector('[aria-haspopup]') as HTMLElement
  trigger.setAttribute('aria-expanded', 'true')
  await leaveRegion()
  await advance(SIDEBAR_REVEAL_CLOSE_DELAY_MS * 3)
  expect(reveal.phase).toBe('open')
  trigger.setAttribute('aria-expanded', 'false')
  await advance(SIDEBAR_REVEAL_CLOSE_DELAY_MS)
  expect(reveal.phase).toBe('closing')
})

test('what holds it out: typing in it, an open popup, a context menu anywhere, a dialog', async () => {
  await render({ enabled: true, dismissKey: 'a' })
  await restAtEdge()
  const frame = reveal.frameRef.current
  expect(sidebarRevealHeld(frame)).toBe(false)

  const input = host.querySelector('input') as HTMLInputElement
  input.focus()
  expect(sidebarRevealHeld(frame)).toBe(true)
  input.blur()

  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  document.body.append(menu)
  expect(sidebarRevealHeld(frame)).toBe(true)
  menu.remove()

  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  document.body.append(dialog)
  expect(sidebarRevealHeld(frame)).toBe(true)
  dialog.remove()

  // An open folder in the tree says aria-expanded too, and is no popup.
  const folder = document.createElement('div')
  folder.setAttribute('role', 'treeitem')
  folder.setAttribute('aria-expanded', 'true')
  frame?.querySelector('aside')?.append(folder)
  expect(sidebarRevealHeld(frame)).toBe(false)
})

test('putting it away lets go of focus inside it rather than leaving it on a hidden row', async () => {
  await render({ enabled: true, dismissKey: 'a' })
  await restAtEdge()
  const button = host.querySelector('button') as HTMLButtonElement
  button.focus()
  expect(document.activeElement).toBe(button)
  act(() => reveal.hide())
  expect(document.activeElement).not.toBe(button)
})
