// @vitest-environment jsdom
// The panel host around a components panel's tree: a save that did not load
// says where, at its file, line and column, in words the person can see
// without opening anything, over the last tree that did load.

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

function session() {
  return createComponentsPanelSession({
    send: () => undefined,
    retained: retainedPanel(KEY),
    development: true,
    visible: true,
  })
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
