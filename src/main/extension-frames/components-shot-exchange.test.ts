import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  MAX_SHOT_IMAGES,
  componentsShotImages,
  componentsShotImageUrl,
  componentsShotReplay,
  componentsShotRequestAllowed,
  createComponentsShotExchange,
} from './components-shot-exchange'

// A shot of a components panel plays the window's side of the `ui.*`
// exchange: it hydrates the guest, checks and acknowledges each tree, keeps
// the last good one, and reports what the panel threw or Studio refused.

const n = (type: string, props: Record<string, unknown> = {}, children: unknown[] = []) => ({ type, props, children })

test('ui.ready is answered with ui.hydrate for that document, and makes the frame a components panel', () => {
  const exchange = createComponentsShotExchange()
  assert.equal(exchange.components, false)
  assert.deepEqual(exchange.hear('ui.ready', { document: 'doc-1' }), [
    { event: 'ui.hydrate', payload: { document: 'doc-1', visible: true } },
  ])
  assert.equal(exchange.components, true)
  assert.equal(exchange.drawn, false)
  assert.deepEqual(exchange.hear('ui.ready', { document: 42 }), [])
  assert.deepEqual(exchange.hear('ui.ready', { document: 'x'.repeat(65) }), [])
})

test('a good tree is acknowledged and kept; a refused one is acknowledged as refused and the last good one stays', () => {
  const exchange = createComponentsShotExchange()
  exchange.hear('ui.ready', { document: 'doc' })
  const good = n('Stack', {}, [n('Text', {}, ['Hello'])])
  assert.deepEqual(exchange.hear('ui.render', { document: 'doc', revision: 1, tree: good }), [
    { event: 'ui.ack', payload: { document: 'doc', revision: 1, accepted: true } },
  ])
  assert.equal(exchange.drawn, true)
  assert.equal(exchange.tree?.type, 'Stack')
  assert.deepEqual(exchange.raw, good)

  assert.deepEqual(exchange.hear('ui.render', { document: 'doc', revision: 2, tree: 'not a node' }), [
    { event: 'ui.ack', payload: { document: 'doc', revision: 2, accepted: false } },
  ])
  assert.deepEqual(exchange.raw, good)
  assert.equal(exchange.errors.length, 1)
  assert.match(exchange.errors[0]!, /^Studio did not draw the panel’s view: /u)
})

test('renders and errors from another document, or before ui.ready, are not heard', () => {
  const exchange = createComponentsShotExchange()
  assert.deepEqual(exchange.hear('ui.render', { document: 'doc', revision: 1, tree: n('Text') }), [])
  exchange.hear('ui.ready', { document: 'doc' })
  assert.deepEqual(exchange.hear('ui.render', { document: 'other', revision: 1, tree: n('Text') }), [])
  assert.deepEqual(exchange.hear('ui.render', { document: 'doc', tree: n('Text') }), [])
  exchange.hear('ui.error', { document: 'other', revision: 0, message: 'not ours' })
  assert.equal(exchange.drawn, false)
  assert.deepEqual(exchange.errors, [])
})

test('what the panel threw and what the check dropped are reported, once each', () => {
  const exchange = createComponentsShotExchange()
  exchange.hear('ui.ready', { document: 'doc' })
  exchange.hear('ui.error', { document: 'doc', revision: 0, message: 'panel.js:3:7 boom' })
  exchange.hear('ui.error', { document: 'doc', revision: 0, message: 'panel.js:3:7 boom' })
  exchange.hear('ui.render', { document: 'doc', revision: 1, tree: n('Text', { sparkle: true }, ['hi']) })
  assert.equal(exchange.errors[0], 'panel.js:3:7 boom')
  assert.equal(exchange.errors.length, 2)
  assert.match(exchange.errors[1]!, /^Warning: .*sparkle/u)
})

test('a panel that renders nothing is drawn as nothing', () => {
  const exchange = createComponentsShotExchange()
  exchange.hear('ui.ready', { document: 'doc' })
  exchange.hear('ui.render', { document: 'doc', revision: 1, tree: null })
  assert.equal(exchange.drawn, true)
  assert.equal(exchange.tree, null)
})

test('the images a tree draws are its Image srcs and its Markdown images, each once and capped', () => {
  const exchange = createComponentsShotExchange()
  exchange.hear('ui.ready', { document: 'doc' })
  exchange.hear('ui.render', {
    document: 'doc',
    revision: 1,
    tree: n('Stack', {}, [
      n('Image', { src: 'media/logo.png', alt: 'Logo' }),
      n('Markdown', { content: 'See ![chart](media/chart.webp) and ![remote](https://example.com/a.png)' }),
      n('Card', {}, [n('Image', { src: 'media/logo.png', alt: 'Again' })]),
    ]),
  })
  assert.deepEqual(componentsShotImages(exchange.tree), ['media/logo.png', 'media/chart.webp'])
  assert.deepEqual(componentsShotImages(null), [])

  const many = createComponentsShotExchange()
  many.hear('ui.ready', { document: 'doc' })
  many.hear('ui.render', {
    document: 'doc',
    revision: 1,
    tree: n(
      'Stack',
      {},
      Array.from({ length: MAX_SHOT_IMAGES + 5 }, (_, index) => n('Image', { src: `i/${index}.png`, alt: 'x' })),
    ),
  })
  assert.equal(componentsShotImages(many.tree).length, MAX_SHOT_IMAGES)
})

test('an assets.image answer becomes a data URL only when it is an image Studio shows', () => {
  assert.equal(
    componentsShotImageUrl({ mime: 'image/png', data: 'iVBORw0KGgo=' }),
    'data:image/png;base64,iVBORw0KGgo=',
  )
  assert.equal(componentsShotImageUrl(null), null)
  assert.equal(componentsShotImageUrl({ mime: 'image/svg+xml', data: 'PHN2Zz4=' }), null)
  assert.equal(componentsShotImageUrl({ mime: 'image/png', data: 'not base64!' }), null)
})

test('the view window loads the app’s own renderer and nothing else', () => {
  const built = new URL('file:///Applications/Studio.app/Contents/Resources/app.asar/out/renderer/index.html')
  assert.equal(componentsShotRequestAllowed(`${built.href}?view=components-shot`, built), true)
  assert.equal(
    componentsShotRequestAllowed(
      'file:///Applications/Studio.app/Contents/Resources/app.asar/out/renderer/assets/a.js',
      built,
    ),
    true,
  )
  assert.equal(componentsShotRequestAllowed('file:///Users/dev/secret.txt', built), false)
  assert.equal(componentsShotRequestAllowed('https://example.com/font.woff2', built), false)
  assert.equal(componentsShotRequestAllowed('data:image/png;base64,AAAA', built), true)

  const dev = new URL('http://localhost:5173/')
  assert.equal(componentsShotRequestAllowed('http://localhost:5173/src/main.tsx', dev), true)
  assert.equal(componentsShotRequestAllowed('ws://localhost:5173/', dev), true)
  assert.equal(componentsShotRequestAllowed('http://localhost:8080/', dev), false)
  assert.equal(componentsShotRequestAllowed('not a url', dev), false)
})

test('a scenario’s tree is checked as a posted one: drawn with its warnings, or refused with the reason', () => {
  const posted = n('Stack', {}, [
    n('Text', {}, ['7 clicks']),
    n('Button', { onPress: { $callback: 'shot.1' }, colour: 'red' }, ['Add']),
  ])
  const replay = componentsShotReplay(posted)
  assert.equal(replay.ok, true)
  if (!replay.ok) return
  assert.equal(replay.drawing.drawn, true)
  assert.equal(replay.drawing.raw, posted)
  assert.equal(replay.drawing.tree?.type, 'Stack')
  assert.equal(replay.errors.length, 1)
  assert.match(replay.errors[0]!, /^Warning: .*colour/u)

  const refused = componentsShotReplay({ type: 'Stack', props: {}, children: 'not a list' })
  assert.equal(refused.ok, false)
  if (refused.ok) return
  assert.match(refused.error, /^Studio did not draw the scenario’s view: /u)
  assert.equal(componentsShotReplay('just text').ok, false)
})
