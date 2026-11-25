// @vitest-environment jsdom
// The panel host around a components panel's tree: a save that did not load
// says where, at its file, line and column, in words the person can see
// without opening anything, over the last tree that did load; and what the
// panel threw, or drew that Studio refused, before its first tree shows at
// once rather than an endless wait.

import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, test } from 'vitest'

import { COMPONENT_MESSAGES as M } from '../../../../../../packages/extension-sdk/src/components/messages'
import { ComponentsPanelHost } from './ComponentsPanelHost'
import { createComponentsPanelSession, forgetRetainedPanel, retainedPanel } from './componentsPanelSession'

const KEY = 'acme.todos/panels/host/ws-1'
afterEach(() => forgetRetainedPanel(KEY))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function session(development = true) {
  return createComponentsPanelSession({
    send: () => undefined,
    retained: retainedPanel(KEY),
    development,
    visible: true,
  })
}

async function shown(drawn: ReturnType<typeof session>): Promise<{ text: string; done: () => Promise<void> }> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <ComponentsPanelHost
        session={drawn}
        extensionName="Todos"
        openLink={() => undefined}
        readImage={async () => null}
        locale="en"
      />,
    )
  })
  return {
    text: host.textContent ?? '',
    done: async () => {
      await act(async () => root.unmount())
      host.remove()
    },
  }
}

test('a failed save shows its file:line:column inline, over the last tree', async () => {
  const first = session()
  first.receive(M.ready, { document: 'one' })
  first.receive(M.render, {
    document: 'one',
    revision: 1,
    tree: { type: 'Text', key: '#0', props: {}, children: ['kept'] },
  })
  const second = session()
  second.failed('src/panel.tsx:3:9 Unexpected token\n    at the transpiler')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <ComponentsPanelHost
        session={second}
        extensionName="Todos"
        openLink={() => undefined}
        readImage={async () => null}
        locale="en"
      />,
    )
  })
  const text = host.textContent ?? ''
  assert.match(text, /This save did not load/)
  assert.match(text, /src\/panel\.tsx:3:9 Unexpected token/)
  assert.match(text, /kept/)
  await act(async () => root.unmount())
  host.remove()
})

test('an error before the first tree is shown at once, not a wait', async () => {
  const drawn = session(false)
  drawn.receive(M.ready, { document: 'one' })
  drawn.receive(M.error, { document: 'one', revision: 0, message: 'src/panel.tsx:3:5 boom' })
  const view = await shown(drawn)
  assert.match(view.text, /Todos: src\/panel\.tsx:3:5 boom/)
  await view.done()
})

test('a first tree Studio refused says so, not a wait', async () => {
  const drawn = session(false)
  drawn.receive(M.ready, { document: 'one' })
  drawn.receive(M.render, {
    document: 'one',
    revision: 1,
    tree: { type: 'Text', props: {}, children: ['x'.repeat(17 * 1024)] },
  })
  const view = await shown(drawn)
  assert.match(view.text, /did not draw the panel’s last view/)
  await view.done()
})

test('an installed panel that stops over its tree does not speak of a save', async () => {
  const drawn = session(false)
  drawn.receive(M.ready, { document: 'one' })
  drawn.receive(M.render, {
    document: 'one',
    revision: 1,
    tree: { type: 'Text', key: '#0', props: {}, children: ['kept'] },
  })
  drawn.failed('It tried to load another page in its place, so Studio closed it.')
  const view = await shown(drawn)
  assert.doesNotMatch(view.text, /This save did not load/)
  assert.match(view.text, /This panel stopped/)
  assert.match(view.text, /kept/)
  await view.done()
})
