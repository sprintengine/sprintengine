// The window's side of a components panel run: it hydrates the guest, checks
// each tree (a refused one keeps the last good tree on screen), answers
// presses against the tree shown, and carries a development folder's state
// across a save: the memory atoms, the last tree, a Reloaded mark, and a
// failed save's error over an inert tree.

import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'

import { COMPONENT_MESSAGES as M } from '../../../../../../packages/extension-sdk/src/components/messages'
import { createComponentsPanelSession, forgetRetainedPanel, retainedPanel } from './componentsPanelSession'

const KEY = 'acme.todos/panels/todos/ws-1'
afterEach(() => forgetRetainedPanel(KEY))

function run(development = true, clock = { now: 1000 }) {
  const sent: Array<{ event: string; payload: Record<string, unknown> }> = []
  const session = createComponentsPanelSession({
    send: (event, payload) => sent.push({ event, payload: payload as Record<string, unknown> }),
    retained: retainedPanel(KEY),
    development,
    visible: true,
    now: () => clock.now,
  })
  return { session, sent, clock }
}

const tree = (text: string) => ({ type: 'Text', key: '#0', props: {}, children: [text] })
const button = { type: 'Button', key: '#0', props: { onPress: { $callback: 'c1' } }, children: ['Go'] }

test('ready is answered with hydrate; a development folder asks for its memory atoms', () => {
  const { session, sent } = run()
  session.receive(M.ready, { document: 'doc-1' })
  assert.deepEqual(sent[0], { event: M.hydrate, payload: { document: 'doc-1', visible: true, retain: true } })
  const installed = run(false)
  installed.session.receive(M.ready, { document: 'doc-2' })
  assert.deepEqual(installed.sent[0]!.payload, { document: 'doc-2', visible: true })
})

test('a good tree is drawn and acknowledged; one over a limit is refused and the last good one stays', () => {
  const { session, sent } = run()
  session.receive(M.ready, { document: 'doc' })
  session.receive(M.render, { document: 'doc', revision: 1, tree: tree('one') })
  assert.deepEqual(session.state().tree, tree('one'))
  assert.deepEqual(sent.at(-1), { event: M.ack, payload: { document: 'doc', revision: 1, accepted: true } })
  const huge = { type: 'Text', props: {}, children: ['x'.repeat(16 * 1024 + 1)] }
  session.receive(M.render, { document: 'doc', revision: 2, tree: huge })
  assert.deepEqual(session.state().tree, tree('one'))
  assert.match(session.state().refused ?? '', /longer than/)
  assert.deepEqual(sent.at(-1), { event: M.ack, payload: { document: 'doc', revision: 2, accepted: false } })
  // The lane refused one: the guest is told to try again a moment later.
  session.receive(M.render, { document: 'doc', revision: 3, tree: tree('three') }, 'rate_limited')
  assert.deepEqual(sent.at(-1)!.payload, { document: 'doc', revision: 3, accepted: false, retryAfterMs: 1000 })
  // A render from another guest is never drawn.
  session.receive(M.render, { document: 'other', revision: 9, tree: tree('nope') })
  assert.deepEqual(session.state().tree, tree('one'))
  session.receive(M.render, { document: 'doc', revision: 4, tree: tree('four') })
  assert.equal(session.state().refused, null)
})

test('a press names the revision shown; the panel’s error is a banner and the tree stays', () => {
  const { session, sent } = run()
  session.dispatch('c1', [])
  assert.equal(sent.length, 0)
  session.receive(M.ready, { document: 'doc' })
  session.receive(M.render, { document: 'doc', revision: 5, tree: button })
  session.dispatch('c1', [], { edit: 3 })
  assert.deepEqual(sent.at(-1), {
    event: M.event,
    payload: { document: 'doc', revision: 5, callback: 'c1', args: [], edit: 3 },
  })
  session.receive(M.error, { document: 'doc', revision: 5, message: 'src/panel.tsx:4:7 boom' })
  assert.deepEqual(session.state().errors, ['src/panel.tsx:4:7 boom'])
  assert.deepEqual(session.state().tree, button)
})

test('a gesture lasts one call within a second of the press', () => {
  const { session, clock } = run()
  assert.equal(session.takeGesture(), false)
  session.grantGesture()
  clock.now += 900
  assert.equal(session.takeGesture(), true)
  assert.equal(session.takeGesture(), false)
  session.grantGesture()
  clock.now += 1001
  assert.equal(session.takeGesture(), false)
  // A press on a control that had not stood still takes back the grant a press before it left open.
  session.grantGesture()
  session.grantGesture(false)
  assert.equal(session.takeGesture(), false)
})

test('a save: memory atoms and the last tree carry over, the next tree shows Reloaded', () => {
  const first = run()
  first.session.receive(M.ready, { document: 'one' })
  first.session.receive(M.render, { document: 'one', revision: 1, tree: tree('half a sen') })
  first.session.receive(M.retain, { document: 'one', entries: [{ key: 'draft', version: 1, value: 'half a sen' }] })
  // The next run starts: the last tree shows at once, answering nothing until its own arrives.
  const second = run()
  assert.deepEqual(second.session.state().tree, tree('half a sen'))
  second.session.receive(M.ready, { document: 'two' })
  assert.deepEqual(second.sent[0]!.payload.memory, { draft: { version: 1, value: 'half a sen' } })
  second.session.dispatch('c1', [])
  assert.equal(second.sent.length, 1)
  second.session.receive(M.render, { document: 'two', revision: 1, tree: tree('half a sen!') })
  assert.equal(second.session.state().reloadedAt, 1000)
})

test('a save that fails to load keeps the last tree, inert, with its error', () => {
  const first = run()
  first.session.receive(M.ready, { document: 'one' })
  first.session.receive(M.render, { document: 'one', revision: 1, tree: button })
  const second = run()
  second.session.failed('src/panel.tsx:3:9 Unexpected token')
  assert.deepEqual(second.session.state().tree, button)
  assert.equal(second.session.state().loadError, 'src/panel.tsx:3:9 Unexpected token')
  second.session.dispatch('c1', [])
  assert.equal(second.sent.length, 0)
  // The next save that loads replaces it and clears the error.
  const third = run()
  third.session.receive(M.ready, { document: 'three' })
  third.session.receive(M.render, { document: 'three', revision: 1, tree: tree('fixed') })
  assert.equal(third.session.state().loadError, null)
  assert.deepEqual(third.session.state().tree, tree('fixed'))
})

test('an installed extension’s run starts from nothing: no kept tree, no Reloaded mark', () => {
  const first = run(false)
  first.session.receive(M.ready, { document: 'one' })
  first.session.receive(M.render, { document: 'one', revision: 1, tree: button })
  assert.equal(first.session.state().run, 'one')
  const second = run(false)
  assert.equal(second.session.state().tree, null)
  assert.equal(second.session.state().run, '')
  assert.equal(second.session.development, false)
  second.session.receive(M.ready, { document: 'two' })
  second.session.receive(M.render, { document: 'two', revision: 1, tree: tree('fresh') })
  assert.equal(second.session.state().reloadedAt, null)
  assert.equal(second.session.state().run, 'two')
})

test('what the lane refused is not taken: an error or a retain over it does nothing', () => {
  const { session } = run()
  session.receive(M.ready, { document: 'doc' })
  session.receive(M.error, { document: 'doc', revision: 0, message: 'x'.repeat(10) }, 'too_large')
  assert.deepEqual(session.state().errors, [])
  session.receive(M.retain, { document: 'doc', entries: [{ key: 'draft', version: 1, value: 'y' }] }, 'rate_limited')
  assert.equal(retainedPanel(KEY).memory.size, 0)
  session.receive(M.retain, { document: 'doc', entries: [{ key: 'draft', version: 1, value: 'y' }] })
  assert.equal(retainedPanel(KEY).memory.size, 1)
})
