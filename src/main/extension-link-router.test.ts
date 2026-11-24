import { expect, test } from 'vitest'

import { createExtensionLinkRouter } from './extension-link-router'

function router() {
  const sent: Array<[string, unknown]> = []
  const opened: string[] = []
  let clock = 0
  const links = createExtensionLinkRouter<string>({
    send: (win, link) => sent.push([win, link]),
    focus: () => undefined,
    openWindow: () => opened.push('window'),
    now: () => clock,
  })
  return { links, sent, opened, advance: (ms: number) => (clock += ms) }
}

test('a link only opens a page in the window listening; a launch link waits for one', () => {
  const { links, sent, opened } = router()
  links.open('sprintengine://extensions/acme.notes?catalog=community')
  expect(opened).toEqual(['window'])
  expect(sent).toEqual([])
  links.ready('main')
  expect(sent).toEqual([['main', { ok: true, id: 'acme.notes', catalogue: 'community' }]])
})

test('the same link twice within a few seconds opens once, and a malformed one is said', () => {
  const { links, sent, advance } = router()
  links.ready('main')
  links.open('sprintengine://extensions/acme.notes')
  links.open('sprintengine://extensions/acme.notes')
  expect(sent).toHaveLength(1)
  advance(5_000)
  links.open('sprintengine://extensions/acme.notes')
  expect(sent).toHaveLength(2)
  links.open('sprintengine://extensions/not-a-key')
  expect(sent.at(-1)?.[1]).toMatchObject({ ok: false })
})
