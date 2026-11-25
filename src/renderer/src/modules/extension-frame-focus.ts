// Keyboard focus enters an extension's frame only on a gesture the person made
// toward it: the pointer over that frame, or a Tab press that walked into it.
// A frame that focuses one of its own elements otherwise (a timer, a message)
// would take the keys the person is typing into Studio, so the window hands
// focus straight back to where it was.

/** A Tab press this recent walked focus into the frame. */
const KEY_WINDOW_MS = 500

type Guard = { dispose(): void }

let installed: Guard | null = null
let users = 0

function extensionFrameOf(element: Element | null): HTMLIFrameElement | null {
  if (!element || element.tagName !== 'IFRAME') return null
  return element.hasAttribute('data-extension') ? (element as HTMLIFrameElement) : null
}

/** Watch this window's focus for frames that take it without a gesture. */
export function installExtensionFrameFocusGuard(
  win: Window & typeof globalThis = window,
  clock: () => number = () => performance.now(),
): Guard {
  const doc = win.document
  let hovered: Element | null = null
  let tabAt = Number.NEGATIVE_INFINITY
  // The last element of the window's own that held focus: where focus goes back to.
  let lastOwn: HTMLElement | null = null

  const check = () => {
    const active = doc.activeElement
    const frame = extensionFrameOf(active)
    if (!frame) return
    if (hovered === frame || frame.contains(hovered)) return
    if (clock() - tabAt <= KEY_WINDOW_MS) return
    const back = lastOwn?.isConnected ? lastOwn : null
    if (back) back.focus({ preventScroll: true })
    else frame.blur()
    if (doc.activeElement === frame) {
      // Nothing of the window's own to return to: leave the frame regardless.
      const body = doc.body
      const tabIndex = body.getAttribute('tabindex')
      body.setAttribute('tabindex', '-1')
      body.focus({ preventScroll: true })
      if (tabIndex === null) body.removeAttribute('tabindex')
      else body.setAttribute('tabindex', tabIndex)
    }
  }
  const onFocusIn = (event: FocusEvent) => {
    const target = event.target
    if (target instanceof win.HTMLElement && target !== doc.body && !extensionFrameOf(target)) lastOwn = target
    // Judged once the focus change has finished, not inside it.
    queueMicrotask(check)
  }
  // Focus moving into a child frame blurs this window; the frame is active by the next task.
  const onBlur = () => win.setTimeout(check, 0)
  const onPointerOver = (event: Event) => {
    hovered = event.target instanceof win.Element ? event.target : null
  }
  const onPointerOut = (event: Event) => {
    if (event.target === hovered) hovered = null
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Tab') tabAt = clock()
  }
  doc.addEventListener('focusin', onFocusIn, true)
  win.addEventListener('blur', onBlur)
  doc.addEventListener('pointerover', onPointerOver, true)
  doc.addEventListener('pointerout', onPointerOut, true)
  doc.addEventListener('keydown', onKeyDown, true)
  return {
    dispose() {
      doc.removeEventListener('focusin', onFocusIn, true)
      win.removeEventListener('blur', onBlur)
      doc.removeEventListener('pointerover', onPointerOver, true)
      doc.removeEventListener('pointerout', onPointerOut, true)
      doc.removeEventListener('keydown', onKeyDown, true)
    },
  }
}

/** One guard per window while any extension surface is mounted. */
export function holdExtensionFrameFocusGuard(): () => void {
  users += 1
  installed ??= installExtensionFrameFocusGuard()
  return () => {
    users -= 1
    if (users === 0) {
      installed?.dispose()
      installed = null
    }
  }
}
