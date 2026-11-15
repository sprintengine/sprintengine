import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, test } from 'vitest'

import { createDataKeySecretCipher } from '../../../server/platform/secret-cipher'
import { ContainerAgentToken } from './container-agent-token'

const scratch = mkdtempSync(join(tmpdir(), 'se-container-token-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const TOKEN = `sk-ant-oat01-${'a1B2_c3-'.repeat(8)}`

test('a token is kept sealed, owner-only, and read back by a fresh store', async () => {
  const cipher = createDataKeySecretCipher(randomBytes(32))
  const path = join(scratch, 'sealed', 'container-claude-token')
  const store = new ContainerAgentToken({ path, cipher })
  assert.deepEqual(await store.status(), { set: false, kept: null })
  assert.equal(store.current(), null)
  assert.deepEqual(await store.set(`  ${TOKEN}\n`), { ok: true })
  assert.equal(store.current(), TOKEN)
  assert.deepEqual(await store.status(), { set: true, kept: 'sealed' })
  assert.ok(!readFileSync(path).toString('latin1').includes('sk-ant-'), 'never written in the clear')
  assert.equal(statSync(path).mode & 0o777, 0o600)
  const again = new ContainerAgentToken({ path, cipher })
  assert.equal(again.current(), null, 'nothing before it is read')
  assert.equal(await again.value(), TOKEN)
  await again.clear()
  assert.equal(await new ContainerAgentToken({ path, cipher }).value(), null)
})

test('what is not a token is refused in words; with no cipher it lasts the session only', async () => {
  const path = join(scratch, 'plain', 'container-claude-token')
  const store = new ContainerAgentToken({
    path,
    cipher: { available: () => false, seal: () => Buffer.alloc(0), open: () => '' },
  })
  const refused = await store.set('ghp_notaclaudetoken')
  assert.equal(refused.ok, false)
  assert.match(refused.ok ? '' : refused.message, /claude setup-token/u)
  assert.deepEqual(await store.set(TOKEN), { ok: true })
  assert.deepEqual(await store.status(), { set: true, kept: 'session' })
  assert.throws(() => statSync(path), 'nothing written')
})
