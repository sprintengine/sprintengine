// EXTENSION_HOST_SERVICES is the one place an extension's calls into Studio
// are checked against what they need: the host's gate reads it, and so do the
// `/testing` fakes. A smoke test with its own table went stale once (it kept
// checking a removed automations service and never checked the workspace
// context), so this reads the keys straight out of the SDK's source and fails
// when one has no row, and reads each service's methods off its fake.
//
// The other direction — every row is a service the host lets an extension
// resolve — is the drift guard's (`npm run test:sdk:drift`), which can load
// the host's allow-list.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { test } from 'vitest'

import { EXTENSION_PERMISSIONS } from '../src/index.js'
import { EXTENSION_HOST_SERVICES, EXTENSION_MAIN_HOST_METHODS, extensionHostService } from '../src/services.js'
import { createFakeWorkspaces, SERVICE_FAKES } from '../src/testing-services.js'

const SRC = join(process.cwd(), 'packages', 'extension-sdk', 'src')

// Every service key the SDK resolves: a `createServiceToken('…')` or a
// `{ key: '…' }` token literal, in any source file but the table itself and
// the testing fakes keyed by it.
function resolvedKeys(): string[] {
  const keys = new Set<string>()
  for (const file of readdirSync(SRC)) {
    if (!file.endsWith('.ts') || file === 'services.ts' || file.startsWith('testing')) continue
    const source = readFileSync(join(SRC, file), 'utf8')
    for (const match of source.matchAll(
      /createServiceToken<[^>]*>\(\s*['"]([^'"]+)['"]\s*\)|\{\s*key:\s*['"]([^'"]+)['"],?\s*\}/g,
    )) {
      keys.add((match[1] ?? match[2])!)
    }
  }
  return [...keys].sort()
}

test('every service key the SDK resolves has a row in EXTENSION_HOST_SERVICES', () => {
  const keys = resolvedKeys()
  assert.ok(keys.length >= 8, `found only ${keys.length} service keys in the SDK source; is the scan broken?`)
  const rows = EXTENSION_HOST_SERVICES.map((service) => service.key).sort()
  assert.deepEqual(rows, keys, 'add a row for each new service (and drop the row of a removed one)')
})

test('every method a service offers has a row, and every row is a method', () => {
  for (const service of EXTENSION_HOST_SERVICES) {
    const fake = SERVICE_FAKES[service.key]
    assert.ok(fake, `${service.key} has a fake`)
    const { registry } = fake!.create({
      moduleId: 'acme',
      permissions: new Set(),
      now: Date.now,
      workspaces: createFakeWorkspaces([]),
    })
    const methods = Object.keys(registry).filter(
      (name) => typeof (registry as Record<string, unknown>)[name] === 'function',
    )
    // What the host calls itself (the storage's data dir, for getModuleDataDir) is not an extension's to call.
    const hostOnly = new Set(['dataDir'])
    assert.deepEqual(
      methods.filter((name) => !hostOnly.has(name)).sort(),
      Object.keys(service.methods).sort(),
      service.key,
    )
  }
})

test('every row names a permission extension.json can ask for, and how a refusal is told', () => {
  const rows = [
    ...EXTENSION_HOST_SERVICES.flatMap((service) => Object.values(service.methods)),
    ...Object.values(EXTENSION_MAIN_HOST_METHODS),
  ]
  for (const row of rows) {
    if (row.extension !== null) assert.ok((EXTENSION_PERMISSIONS as readonly string[]).includes(row.extension))
    assert.ok(row.refusal === 'answer' || row.refusal === 'throw')
  }
})

test('the rows that carry the most weight', () => {
  // Starting a chat needs, of whoever set the call off, that they may start one.
  assert.deepEqual(extensionHostService('conversation.module-service')?.methods.create, {
    extension: 'conversation:own',
    invoker: 'conversation:create',
    refusal: 'answer',
  })
  // The GitHub sign-in is the person's alone.
  assert.equal(extensionHostService('github.module-service')?.methods.request?.invoker, 'owner')
  assert.equal(extensionHostService('automations.module-service'), undefined, 'automations is gone')
})
