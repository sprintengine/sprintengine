import { expect, test } from 'vitest'

import { extensionLinkFromArgv, parseExtensionInstallLink } from './extension-install-link'

test('a link names an extension and a catalogue, official by default', () => {
  expect(parseExtensionInstallLink('sprintengine://extensions/acme.notes')).toEqual({
    ok: true,
    id: 'acme.notes',
    catalogue: 'official',
  })
  expect(parseExtensionInstallLink('sprintengine://extensions/acme.notes?catalog=community')).toEqual({
    ok: true,
    id: 'acme.notes',
    catalogue: 'community',
  })
  expect(
    parseExtensionInstallLink(
      `sprintengine://extensions/acme.notes?catalog=${encodeURIComponent('https://github.com/acme/catalogue.git')}`,
    ),
  ).toEqual({ ok: true, id: 'acme.notes', catalogue: 'git:https://github.com/acme/catalogue.git' })
})

test('a malformed link, another parameter, a bad catalogue or a reserved name elsewhere is refused', () => {
  for (const link of [
    'sprintengine://extensions/notes',
    'sprintengine://extensions/acme.notes?catalog=community&install=1',
    'sprintengine://extensions/acme.notes?catalog=http://example.com/x.git',
    'sprintengine://extensions/acme.notes?catalog=https://token@github.com/acme/x.git',
    'sprintengine://extensions/sprintengine.notes?catalog=community',
    `sprintengine://extensions/acme.notes?catalog=${'a'.repeat(2100)}`,
  ])
    expect(parseExtensionInstallLink(link).ok).toBe(false)
  expect(parseExtensionInstallLink('sprintengine://extensions/sprintengine.notes').ok).toBe(true)
})

test('a launch argument carrying a link is found, and an oversized one is not trimmed into a valid one', () => {
  expect(extensionLinkFromArgv(['/Applications/Studio', 'sprintengine://extensions/acme.notes'])).toBe(
    'sprintengine://extensions/acme.notes',
  )
  expect(extensionLinkFromArgv(['sprintengine://chat/x/y'])).toBeNull()
  const long = `sprintengine://extensions/acme.notes?catalog=${'a'.repeat(3000)}`
  expect(parseExtensionInstallLink(extensionLinkFromArgv([long])!).ok).toBe(false)
})
