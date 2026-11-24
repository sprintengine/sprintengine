import assert from 'node:assert/strict'

import { test } from 'vitest'

import { isGitAuthFailure } from '../src/git-source.js'
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
    source: {
      kind: 'git',
      url: 'https://github.com/acme/tools.git',
      ref: 'main',
      path: 'extensions/notes',
      tree: 'main/extensions/notes',
    },
  })
  assert.deepEqual(readExtensionInstallSource('https://gitlab.example.com/acme/tools/-/tree/v2'), {
    ok: true,
    source: { kind: 'git', url: 'https://gitlab.example.com/acme/tools.git', ref: 'v2' },
  })
})

test('a branch or a tag spelled in full is a ref; a pull request’s is not', () => {
  assert.deepEqual(readExtensionInstallSource('acme/notes@refs/tags/v1.2.0'), {
    ok: true,
    source: { kind: 'git', url: 'https://github.com/acme/notes.git', ref: 'refs/tags/v1.2.0' },
  })
  const pull = readExtensionInstallSource('acme/notes@refs/pull/42/head')
  assert.match(pull.ok ? '' : pull.message, /pull request/)
})

test('what is none of them is refused, with the forms', () => {
  for (const text of [
    '',
    'notes',
    'https://github.com/acme/tools/blob/main/extension.json',
    'acme/notes@--upload-pack=x',
    'https://github.com/acme/tools/tree/main/../x',
    'acme/notes.git#',
    'acme/notes@refs/pull/42/head',
    'acme/notes@pull/42/head',
    'https://gitlab.example.com/acme/notes.git#refs/merge-requests/3/head',
    'https://github.com/acme/notes.git#refs/remotes/origin/main',
    // A malformed escape is refused, not thrown.
    'https://github.com/acme/tools/tree/main/%E0%A4%A',
    'https://github.com/acme/tools/tree/%zz/notes',
    'https://github.com/acme/notes/releases/tag/%',
  ])
    assert.equal(readExtensionInstallSource(text).ok, false, text)
})

test('a folder link whose branch holds / is handed on whole, for Studio to split where a ref ends', () => {
  const read = readExtensionInstallSource('https://github.com/acme/tools/tree/feature/x/notes')
  assert.deepEqual(read, {
    ok: true,
    source: {
      kind: 'git',
      url: 'https://github.com/acme/tools.git',
      ref: 'feature',
      path: 'x/notes',
      tree: 'feature/x/notes',
    },
  })
})

test('a release’s or a tag’s page is read as that tag', () => {
  for (const [link, url] of [
    ['https://github.com/acme/notes/releases/tag/v1.4.0', 'https://github.com/acme/notes.git'],
    ['https://gitlab.example.com/acme/notes/-/releases/v1.4.0', 'https://gitlab.example.com/acme/notes.git'],
    ['https://gitlab.example.com/acme/notes/-/tags/v1.4.0', 'https://gitlab.example.com/acme/notes.git'],
  ])
    assert.deepEqual(readExtensionInstallSource(link!), {
      ok: true,
      source: { kind: 'git', url, ref: 'refs/tags/v1.4.0' },
    })
})

test('--ref names the ref of a source naming none, once; --catalogue chooses a key’s catalogue', () => {
  assert.deepEqual(readExtensionInstallSource('acme/notes', { ref: 'v1.2.0' }), {
    ok: true,
    source: { kind: 'git', url: 'https://github.com/acme/notes.git', ref: 'v1.2.0' },
  })
  assert.deepEqual(
    readExtensionInstallSource('https://github.com/acme/tools/tree/feature/x/notes', { ref: 'feature/x' }),
    {
      ok: true,
      source: { kind: 'git', url: 'https://github.com/acme/tools.git', ref: 'feature/x', path: 'notes' },
    },
  )
  assert.equal(readExtensionInstallSource('acme/notes@v1', { ref: 'v2' }).ok, false, 'named twice')
  assert.equal(
    readExtensionInstallSource('https://github.com/acme/tools/tree/feature/x/notes', { ref: 'main' }).ok,
    false,
    'a folder link must start with the ref named',
  )
  assert.equal(readExtensionInstallSource('acme/notes', { ref: 'refs/pull/1/head' }).ok, false)
  assert.equal(readExtensionInstallSource('acme.notes', { ref: 'v1' }).ok, false, 'a key has no ref')
  assert.deepEqual(readExtensionInstallSource('acme.notes', { catalogue: 'community' }), {
    ok: true,
    source: { kind: 'catalogue', key: 'acme.notes', catalogue: 'community' },
  })
  assert.equal(readExtensionInstallSource('acme/notes', { catalogue: 'community' }).ok, false)
})

test('a git failure for want of credentials reads as one', () => {
  for (const message of [
    "git ls-remote failed: fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    'git fetch failed: remote: Repository not found.',
    'git fetch failed: git@github.com: Permission denied (publickey).',
    'git fetch failed: fatal: Authentication failed for https://git.example.com/acme/notes.git/',
  ])
    assert.equal(isGitAuthFailure(message), true, message)
  assert.equal(isGitAuthFailure("git fetch failed: fatal: couldn't find remote ref nope"), false)
})
