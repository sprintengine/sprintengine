import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'

import type { StudioExtensionCallAnswer } from '../../../../../packages/studio-protocol/src/public'
import type { ChoiceDialogOptions, DialogChoice } from '../ui/ConfirmDialog'
import { createExtensionOpener, forgetAllowedHosts } from './extensionOpener'

// Every open a components panel makes is admitted by its Studio, asked of the
// person for a web address, admitted again just before it happens, and
// withdrawn when the run ends.

const KEY = 'local.links'
afterEach(() => forgetAllowedHosts(KEY))

function scene(admit: () => StudioExtensionCallAnswer = () => ({ ok: true, result: null })) {
  const run = new AbortController()
  const calls: string[] = []
  const opened: string[] = []
  const asked: Array<{ options: ChoiceDialogOptions; answer: (choice: DialogChoice) => void }> = []
  const opener = createExtensionOpener({
    extensionKey: KEY,
    extensionName: 'Links',
    call: async (method, params) => {
      calls.push(`${method} ${(params as { url: string }).url}`)
      return admit()
    },
    dialog: () => ({
      choose: (options) =>
        new Promise<DialogChoice>((resolve) => {
          asked.push({ options, answer: resolve })
        }),
    }),
    openWeb: async (url) => {
      opened.push(url)
      return true
    },
    openMail: (url) => void opened.push(url),
    signal: run.signal,
  })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  return { run, calls, opened, asked, opener, settle }
}

test('a Link is admitted by the Studio, asked, admitted again, and opened', async () => {
  const { calls, opened, asked, opener, settle } = scene()
  const done = opener.openLink('https://example.com/a')
  await settle()
  assert.deepEqual(calls, ['shell.openExternal https://example.com/a'])
  assert.equal(asked.length, 1)
  asked[0]!.answer('confirm')
  assert.equal(await done, true)
  assert.deepEqual(calls, ['shell.openExternal https://example.com/a', 'shell.openExternal https://example.com/a'])
  assert.deepEqual(opened, ['https://example.com/a'])
})

test('approval revoked on the Studio alone: the Link is refused, asked of no one, and nothing opens', async () => {
  const { opened, asked, opener } = scene(() => ({ ok: false, code: 'approval_required', message: 'Not approved.' }))
  assert.equal(await opener.openLink('https://example.com/a'), false)
  assert.equal(await opener.openLink('mailto:dev@example.com'), false)
  assert.equal(asked.length, 0)
  assert.deepEqual(opened, [])
})

test('the prompt open, the panel closed, then confirmed: the prompt is withdrawn and nothing opens', async () => {
  const { run, calls, opened, asked, opener, settle } = scene()
  const done = opener.openExternal('https://example.com/a')
  await settle()
  const signal = asked[0]!.options.signal!
  run.abort()
  assert.equal(signal.aborted, true, 'the dialog is told the question is withdrawn')
  asked[0]!.answer('confirm')
  assert.equal(await done, false)
  assert.deepEqual(calls, [], 'nothing is even asked of the Studio once the run ended')
  assert.deepEqual(opened, [])
})

test('approval lost while the prompt is open: confirmed, the open is refused', async () => {
  let approved = true
  const { opened, asked, opener, settle } = scene(() =>
    approved ? { ok: true, result: null } : { ok: false, code: 'approval_required', message: 'Not approved.' },
  )
  const done = opener.openExternal('https://example.com/a')
  await settle()
  approved = false
  asked[0]!.answer('alternate')
  assert.equal(await done, false)
  assert.deepEqual(opened, [])
  // Refused, so "Always allow" was not kept either.
  approved = true
  const again = opener.openExternal('https://example.com/b')
  await settle()
  assert.equal(asked.length, 2)
  asked[1]!.answer('cancel')
  assert.equal(await again, false)
})

test('"Always allow" skips the question for that host until the extension is taken out', async () => {
  const { opened, asked, opener, settle } = scene()
  const first = opener.openExternal('https://example.com/a')
  await settle()
  asked[0]!.answer('alternate')
  assert.equal(await first, true)
  assert.equal(await opener.openExternal('https://example.com/b'), true)
  assert.equal(asked.length, 1)
  assert.deepEqual(opened, ['https://example.com/a', 'https://example.com/b'])
  forgetAllowedHosts(KEY)
  void opener.openExternal('https://example.com/c')
  await settle()
  assert.equal(asked.length, 2)
})
