import assert from 'node:assert/strict'

import { test } from 'vitest'

import { readExtensionInstallSource } from '../src/install-source.js'

// The four ways to name a published extension, and what is refused.

test('a catalogue key is read as one', () => {
  assert.deepEqual(readExtensionInstallSource('acme.notes'), {
    ok: true,
    source: { kind: 'catalogue', key: 'acme.notes' },
  })
})

test('owner/repo is a GitHub repository, @ref its ref', () => {
  assert.deepEqual(readExtensionInstallSource('acme/notes'), {
    ok: true,
    source: { kind: 'git', url: 'https://github.com/acme/notes.git' },
  })
  assert.deepEqual(readExtensionInstallSource('acme/notes.js@v1.2.0'), {
    ok: true,
    source: { kind: 'git', url: 'https://github.com/acme/notes.js.git', ref: 'v1.2.0' },
  })
})

test('a git URL takes its ref after #', () => {
  assert.deepEqual(readExtensionInstallSource('https://git.example.com/acme/notes.git#release/2'), {
    ok: true,
    source: { kind: 'git', url: 'https://git.example.com/acme/notes.git', ref: 'release/2' },
  })
  assert.deepEqual(readExtensionInstallSource('git@github.com:acme/notes.git'), {
    ok: true,
    source: { kind: 'git', url: 'git@github.com:acme/notes.git' },
  })
  assert.deepEqual(readExtensionInstallSource('file:///Users/dev/repos/acme/notes#main'), {
    ok: true,
    source: { kind: 'git', url: 'file:///Users/dev/repos/acme/notes', ref: 'main' },
  })
})

test('a folder link names the ref, then the folder', () => {
  assert.deepEqual(readExtensionInstallSource('https://github.com/acme/tools/tree/main/extensions/notes'), {
    ok: true,
    source: { kind: 'git', url: 'https://github.com/acme/tools.git', ref: 'main', path: 'extensions/notes' },
  })
  assert.deepEqual(readExtensionInstallSource('https://gitlab.example.com/acme/tools/-/tree/v2'), {
    ok: true,
    source: { kind: 'git', url: 'https://gitlab.example.com/acme/tools.git', ref: 'v2' },
  })
})

test('what is none of them is refused, with the forms', () => {
  for (const text of [
    '',
    'notes',
    'https://github.com/acme/tools/blob/main/extension.json',
    'acme/notes@--upload-pack=x',
    'https://github.com/acme/tools/tree/main/../x',
    'acme/notes.git#',
  ])
    assert.equal(readExtensionInstallSource(text).ok, false, text)
})
