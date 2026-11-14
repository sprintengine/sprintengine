// What the desktop tells a distribution's Studio about its WSL terminal
// agents' launch tokens: only digests, each issue and revoke, and every live
// token again (replacing what it held) on each new connection.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'vitest'

import { createWslLaunchTokens } from './wsl-launch-tokens'

type Sent = { distro: string; params: { tokens: Array<{ digest: string; identity: unknown }>; replace?: boolean } }

function servers() {
  const sent: Sent[] = []
  const running = new Set<string>()
  const connection = (distro: string) => ({
    owner: {
      request: async (method: string, params: Sent['params']) => {
        assert.equal(method, 'environment.launchTokens')
        sent.push({ distro, params })
        return { held: params.tokens.length }
      },
    } as never,
  })
  return {
    sent,
    running,
    connection,
    deps: {
      connect: async (distro: string) => {
        running.add(distro)
        return connection(distro)
      },
      current: (distro: string) => (running.has(distro) ? connection(distro) : null),
    },
  }
}

const digest = (token: string) => createHash('sha256').update(token).digest('hex')
const identity = { workspaceId: 'ws-1', agentId: 'agent-1', cliId: 'codex' }

test('an issued token reaches the distribution as its digest and the agent it proves, never as itself', async () => {
  const fake = servers()
  const tokens = createWslLaunchTokens(fake.deps)
  const { token, sent } = tokens.issue('Ubuntu', identity)
  await sent
  assert.match(token, /^selaunch_[A-Za-z0-9_-]{43}$/u)
  assert.deepEqual(fake.sent, [{ distro: 'Ubuntu', params: { tokens: [{ digest: digest(token), identity }] } }])
  assert.equal(JSON.stringify(fake.sent).includes(token), false)

  tokens.revoke('Ubuntu', token)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(fake.sent[1], { distro: 'Ubuntu', params: { tokens: [{ digest: digest(token), identity: null }] } })
  tokens.revoke('Ubuntu', token)
  assert.equal(fake.sent.length, 2, 'a token revoked twice is told once')
})

test('a revoke never starts a server, and a new connection is told every live token in place of what it held', async () => {
  const fake = servers()
  const tokens = createWslLaunchTokens(fake.deps)
  const kept = tokens.issue('Ubuntu', identity)
  const gone = tokens.issue('Ubuntu', { workspaceId: 'ws-2', agentId: 'agent-2' })
  await Promise.all([kept.sent, gone.sent])
  fake.running.delete('Ubuntu')
  tokens.revoke('Ubuntu', gone.token)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(fake.sent.length, 2, 'nothing sent to a server that is not running')

  // The server came back: it hears only the live one, and drops the rest.
  tokens.connected('Ubuntu', fake.connection('Ubuntu'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(fake.sent.at(-1), {
    distro: 'Ubuntu',
    params: { tokens: [{ digest: digest(kept.token), identity }], replace: true },
  })
  // Another distribution's tokens are its own.
  tokens.connected('Debian', fake.connection('Debian'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(fake.sent.at(-1), { distro: 'Debian', params: { tokens: [], replace: true } })
})

test('many live tokens go in calls the protocol takes, the first replacing what was held', async () => {
  const fake = servers()
  const tokens = createWslLaunchTokens(fake.deps)
  await Promise.all(
    Array.from({ length: 300 }, (_, index) => tokens.issue('Ubuntu', { ...identity, agentId: `agent-${index}` }).sent),
  )
  fake.sent.length = 0
  tokens.connected('Ubuntu', fake.connection('Ubuntu'))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(
    fake.sent.map((entry) => [entry.params.tokens.length, entry.params.replace === true]),
    [
      [256, true],
      [44, false],
    ],
  )
})
