import { isComponentImagePath } from '../../../packages/extension-sdk/src/components/catalog'
import { COMPONENT_MESSAGES as M } from '../../../packages/extension-sdk/src/components/messages'
import {
  parseComponentTree,
  type ComponentChild,
  type ComponentNode,
  type UnsupportedNode,
} from '../../../packages/extension-sdk/src/components/tree'

// A shot of a components panel (extension-shot.ts): the frame draws nothing
// of its own, because its hidden module only renders a tree and posts it to
// the window, which checks it and draws it with Studio's controls. So the
// shot plays the window's side of the `ui.*` exchange
// (packages/extension-sdk/src/components/messages.ts) as the panel session
// does (renderer componentsPanelSession.ts): `ui.ready` is answered with
// `ui.hydrate`, every `ui.render` is checked and acknowledged, and the last
// tree that passed is kept for the picture. No press or edit is ever sent:
// a picture is taken of the panel's first look.
//
// What the panel threw (`ui.error`), a tree Studio refused, and what the check
// dropped or drew as a placeholder (its warnings) all go into the shot's
// `errors`: the author asked for a picture to find out what is wrong with it,
// and a dropped prop is exactly that.

export type ComponentsShotTree = ComponentNode | UnsupportedNode | null

export type ComponentsShotAnswer = { event: string; payload: Record<string, unknown> }

// As many lines as the window keeps of each, so one noisy panel cannot flood the result.
const MAX_MESSAGES = 20
const MAX_MESSAGE_LENGTH = 500
// The images pre-read for one picture: every one is a round trip to the Studio.
export const MAX_SHOT_IMAGES = 32
// A Markdown image, `![alt](path)` or `![alt](<path>)`, as the panel's Markdown names one.
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/gu

function field(payload: unknown, name: string): unknown {
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>)[name] : undefined
}

export type ComponentsShotExchange = ReturnType<typeof createComponentsShotExchange>

export function createComponentsShotExchange() {
  let document: string | null = null
  let drawn = false
  let tree: ComponentsShotTree = null
  // The guest's own tree as it posted it: the shot's view checks it again, as the window does.
  let raw: unknown = null
  const errors: string[] = []
  const note = (message: string) => {
    const line = message.slice(0, MAX_MESSAGE_LENGTH)
    if (!errors.includes(line) && errors.length < MAX_MESSAGES) errors.push(line)
  }
  const ours = (payload: unknown) => document !== null && field(payload, 'document') === document

  return {
    /** The frame is a components panel: its runtime said `ui.ready`. */
    get components(): boolean {
      return document !== null
    },
    /** A tree was accepted: the panel has something to picture. */
    get drawn(): boolean {
      return drawn
    },
    /** The last accepted tree, checked. */
    get tree(): ComponentsShotTree {
      return tree
    },
    /** The last accepted tree as the guest posted it. */
    get raw(): unknown {
      return raw
    },
    errors,
    /** One event the frame posted; answers with what the window would send back. */
    hear(event: string, payload: unknown): ComponentsShotAnswer[] {
      if (event === M.ready) {
        const id = field(payload, 'document')
        if (typeof id !== 'string' || id.length > 64) return []
        document = id
        return [{ event: M.hydrate, payload: { document, visible: true } }]
      }
      if (event === M.render) {
        const revision = field(payload, 'revision')
        if (!ours(payload) || typeof revision !== 'number') return []
        const posted = field(payload, 'tree')
        const checked = parseComponentTree(posted)
        if (!checked.ok) {
          note(`Studio did not draw the panel’s view: ${checked.error}`)
          return [{ event: M.ack, payload: { document, revision, accepted: false } }]
        }
        for (const warning of checked.warnings) note(`Warning: ${warning}`)
        drawn = true
        tree = checked.tree
        raw = posted
        return [{ event: M.ack, payload: { document, revision, accepted: true } }]
      }
      if (event === M.error) {
        const message = field(payload, 'message')
        if (ours(payload) && typeof message === 'string') note(message)
      }
      return []
    },
  }
}

/** What a shot draws: a checked tree, the tree as posted, and what the check said of it. */
export type ComponentsShotDrawing = { drawn: boolean; tree: ComponentsShotTree; raw: unknown }

/**
 * A tree the author's CLI rendered on its own machine (`shot --scenario`),
 * checked as the window checks a posted one: the drawing, and its warnings in
 * the shot's words; or why Studio would not draw it.
 */
export function componentsShotReplay(
  posted: unknown,
): { ok: true; drawing: ComponentsShotDrawing; errors: string[] } | { ok: false; error: string } {
  const checked = parseComponentTree(posted)
  if (!checked.ok) return { ok: false, error: `Studio did not draw the scenario’s view: ${checked.error}` }
  const errors: string[] = []
  for (const warning of checked.warnings) {
    const line = `Warning: ${warning}`.slice(0, MAX_MESSAGE_LENGTH)
    if (!errors.includes(line) && errors.length < MAX_MESSAGES) errors.push(line)
  }
  return { ok: true, drawing: { drawn: true, tree: checked.tree, raw: posted }, errors }
}

/** The extension images a checked tree draws (Image, and images in Markdown), at most MAX_SHOT_IMAGES. */
export function componentsShotImages(tree: ComponentsShotTree): string[] {
  const found = new Set<string>()
  const stack: ComponentChild[] = tree ? [tree] : []
  while (stack.length > 0 && found.size < MAX_SHOT_IMAGES) {
    const node = stack.pop()!
    if (typeof node === 'string' || node.type === 'Unsupported') continue
    if (node.type === 'Image' && typeof node.props.src === 'string') found.add(node.props.src)
    if (node.type === 'Markdown' && typeof node.props.content === 'string')
      for (const match of node.props.content.matchAll(MARKDOWN_IMAGE)) {
        if (found.size >= MAX_SHOT_IMAGES) break
        if (isComponentImagePath(match[1]!)) found.add(match[1]!)
      }
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]!)
  }
  return [...found]
}

/** An `assets.image` answer as a `data:` URL, or null when it is not one Studio shows. */
export function componentsShotImageUrl(result: unknown): string | null {
  const mime = field(result, 'mime')
  const data = field(result, 'data')
  if (typeof mime !== 'string' || !/^image\/(?:png|jpeg|webp)$/u.test(mime)) return null
  if (typeof data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)) return null
  return `data:${mime};base64,${data}`
}

/**
 * Whether the window that draws the shot may load a URL: the app's own
 * renderer (its document, scripts, styles and fonts; under the dev server, its
 * origin and that origin's socket) and the `data:`/`blob:` URLs it makes,
 * nothing else.
 */
export function componentsShotRequestAllowed(target: string, app: URL): boolean {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return false
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') return true
  if (app.protocol === 'file:') {
    const root = app.pathname.slice(0, app.pathname.lastIndexOf('/') + 1)
    return url.protocol === 'file:' && url.pathname.startsWith(root) && !url.pathname.split('/').includes('..')
  }
  return (
    (url.protocol === app.protocol || url.protocol === (app.protocol === 'https:' ? 'wss:' : 'ws:')) &&
    url.host === app.host
  )
}
