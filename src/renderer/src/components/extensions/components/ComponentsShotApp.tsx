import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'

import { parseComponentTree } from '../../../../../../packages/extension-sdk/src/components/tree'
import { EmptyState } from '../../ui/EmptyState'
import { ComponentsView } from './ComponentsView'
import type { ComponentsTree } from './componentsViewTypes'

// The window a shot of a components panel is drawn in (`?view=components-shot`,
// main's extension-shot.ts). The panel's own run happened in its hidden frame,
// where main played the window's side and kept the last tree Studio accepted;
// this page only draws that tree with Studio's own controls, as a panel tab
// does (ComponentsPanelHost), so the picture is what the person would see. No
// extension code runs here: the tree is data, checked again as the window
// checks it, and its images are the ones main read beforehand.
//
// Main hands the tree over with `window.__seComponentsShot`, whose promise
// settles once the tree is committed, its images are decoded and two frames
// have painted it.

export type ComponentsShotInput = {
  /** The tree as the panel posted it, or null. */
  tree: unknown
  /** The extension's images the tree draws, by `src`, as `data:` URLs; any other answers null. */
  images: Record<string, string>
  theme: 'light' | 'dark'
  /** The panel did not load and drew nothing: why. */
  failure?: string
}

declare global {
  interface Window {
    __seComponentsShot?: (input: ComponentsShotInput) => Promise<void>
  }
}

// As the window decodes an extension's image (ExtensionSurfaceMount.readOwnImage).
const MAX_IMAGE_SIDE = 4096
// An image that never decodes must not hold the picture past main's own deadline.
const IMAGE_WAIT_MS = 3000

type Shot = { tree: ComponentsTree; failure: string | null; images: Record<string, string>; settle: () => void }

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 16)
  })
}

async function twoFrames(): Promise<void> {
  await nextFrame()
  await nextFrame()
}

function decoded(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const probe = new Image()
    const timer = setTimeout(() => resolve(null), IMAGE_WAIT_MS)
    probe.onload = () => {
      clearTimeout(timer)
      resolve(probe.naturalWidth <= MAX_IMAGE_SIDE && probe.naturalHeight <= MAX_IMAGE_SIDE ? url : null)
    }
    probe.onerror = () => {
      clearTimeout(timer)
      resolve(null)
    }
    probe.src = url
  })
}

function applyTheme(theme: 'light' | 'dark'): void {
  // Both attributes, as the app's theme does (hooks/useAppTheme.ts): the
  // design-system tokens key their dark values off `data-mode`.
  document.documentElement.setAttribute('data-theme', theme)
  document.documentElement.setAttribute('data-mode', theme)
}

const noop = (): void => undefined

export default function ComponentsShotApp(): ReactElement {
  const [shot, setShot] = useState<Shot | null>(null)
  // Every image the view asked for: the picture waits for each.
  const reads = useRef<Promise<unknown>[]>([])

  useEffect(() => {
    window.__seComponentsShot = (input) =>
      new Promise<void>((resolve, reject) => {
        const checked = parseComponentTree(input.tree)
        if (!checked.ok) {
          reject(new Error(checked.error))
          return
        }
        applyTheme(input.theme)
        reads.current = []
        setShot({
          tree: checked.tree,
          failure: input.failure ?? null,
          images: input.images,
          settle: resolve,
        })
      })
    return () => {
      delete window.__seComponentsShot
    }
  }, [])

  // After React committed the tree: wait for the images it asked for, then
  // for what those draw, then two frames so the capture sees it painted.
  useLayoutEffect(() => {
    if (!shot) return
    let live = true
    void (async () => {
      await twoFrames()
      for (let seen = -1; seen !== reads.current.length;) {
        seen = reads.current.length
        await Promise.all(reads.current)
        await twoFrames()
      }
      await Promise.all(
        Array.from(document.images, (image) => (image.complete ? undefined : image.decode().catch(noop))),
      )
      await twoFrames()
      if (live) shot.settle()
    })()
    return () => {
      live = false
    }
  }, [shot])

  // Stable per shot: the view reads an image again whenever this changes.
  const readImage = useCallback(
    (src: string): Promise<string | null> => {
      const url = shot?.images[src]
      const read = url ? decoded(url) : Promise.resolve(null)
      reads.current.push(read)
      return read
    },
    [shot],
  )

  return (
    <div
      className="h-full min-h-0 overflow-hidden bg-[color:var(--bg-surface)] p-[var(--sem-space-lg)] text-[color:var(--text-default)]"
      data-components-shot=""
    >
      {shot && !shot.tree && shot.failure ? (
        <EmptyState title="This panel could not load" body={shot.failure} />
      ) : shot ? (
        // Inset as the panel host insets it in a pane (ComponentsPanelHost.tsx).
        <ComponentsView
          tree={shot.tree}
          revision={1}
          dispatch={noop}
          grantGesture={noop}
          openLink={noop}
          readImage={readImage}
          inert={false}
          locale="en"
        />
      ) : null}
    </div>
  )
}
