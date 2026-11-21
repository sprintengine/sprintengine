import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'vitest'

import { createModuleLifecycle } from './module-lifecycle'
import { createModuleRegistryMirror } from './registry-mirror'
import { NO_EXTENSION_RUN } from './third-party-module-view'

// The SDK's sample content extension, installed from its folder the way the
// person installs one: it needs no approval, its grammar is served checked
// and as data. A broken grammar is refused at
// install, and one broken after install is not served.

const SAMPLE = join(process.cwd(), 'packages/extension-sdk/examples/content-sample')
const KEY = 'local.tally-language'

function setUp() {
  const dataDir = mkdtempSync(join(tmpdir(), 'content-'))
  const changes: string[] = []
  const lifecycle = createModuleLifecycle({
    dataDir,
    moduleRoot: () => join(dataDir, 'extensions'),
    view: () => null,
    applyEnablement: async () => ({ ok: true }),
    changed: () => changes.push('changed'),
    run: () => NO_EXTENSION_RUN,
    registry: createModuleRegistryMirror(),
  })
  return { dataDir, lifecycle, changes }
}

test('the sample installs with no approval asked, and its grammar is served checked, as data', async () => {
  const { lifecycle, changes } = setUp()
  const installed = await lifecycle.install(SAMPLE)
  assert.ok(installed.ok, installed.ok ? '' : installed.message)
  assert.equal(installed.moduleId, KEY)
  assert.deepEqual(installed.approval, { state: 'not-needed' }, 'content alone is never put to the person')
  assert.deepEqual(changes, ['changed'])

  const listed = await lifecycle.installed()
  assert.equal(listed.modules[0]?.launch.status, 'runs_without_worker')
  const served = await lifecycle.contributions()
  assert.deepEqual(
    served.extensions.map((entry) => entry.id),
    [KEY],
    'what it adds reaches every client at once',
  )

  const content = await lifecycle.content({ moduleId: KEY, kind: 'syntax', id: 'tally' })
  assert.ok(content.ok, content.ok ? '' : content.message)
  assert.equal(content.content.grammar.scopeName, 'source.tally')
  assert.equal('$schema' in content.content.grammar, false, 'keys the engine does not read are dropped')
  assert.equal('fileTypes' in content.content.grammar, false)
  assert.deepEqual(content.content.configuration?.comments, { lineComment: '#' })
  assert.equal(JSON.stringify(content).includes(SAMPLE), false, 'never a path on this disk')

  const missing = await lifecycle.content({ moduleId: KEY, kind: 'syntax', id: 'nope' })
  assert.equal(missing.ok, false)
})

test('a grammar is checked again each time it is served: one broken after install is not', async () => {
  const { dataDir, lifecycle } = setUp()
  assert.ok((await lifecycle.install(SAMPLE)).ok)
  const grammarPath = join(dataDir, 'extensions', KEY, 'syntaxes', 'tally.tmLanguage.json')
  writeFileSync(
    grammarPath,
    readFileSync(grammarPath, 'utf8').replace('"scopeName": "source.tally"', '"scopeName": "source.other"'),
  )
  const content = await lifecycle.content({ moduleId: KEY, kind: 'syntax', id: 'tally' })
  assert.equal(content.ok, false)
  if (content.ok) return
  assert.match(content.message, /\(scopeName\): must be "source.tally"/)
})

test('a grammar that would never highlight is refused at install', async () => {
  const { lifecycle } = setUp()
  const folder = mkdtempSync(join(tmpdir(), 'broken-'))
  cpSync(SAMPLE, folder, { recursive: true })
  const grammarPath = join(folder, 'syntaxes', 'tally.tmLanguage.json')
  const grammar = JSON.parse(readFileSync(grammarPath, 'utf8')) as { patterns: unknown[] }
  grammar.patterns.push({ include: '#nowhere' })
  writeFileSync(grammarPath, JSON.stringify(grammar))
  const installed = await lifecycle.install(folder)
  assert.equal(installed.ok, false)
  if (installed.ok) return
  assert.match(installed.issues?.[0]?.message ?? '', /names no repository rule: #nowhere/)
})
