import assert from 'node:assert/strict'
import { test } from 'vitest'

import { createHash } from 'node:crypto'

import {
  applyGatewayLaunchTokenChange,
  applyGatewayLaunchTokenChanges,
  issueGatewayLaunchToken,
  isGatewayLaunchTokenLive,
  onGatewayLaunchTokenEnded,
  liveGatewayLaunchTokens,
  onGatewayLaunchTokenChange,
  resolveGatewayLaunchToken,
  revokeGatewayLaunchToken,
  type LaunchTokenChange,
} from './gateway-launch-tokens'

// Out of process the shell issues the launch tokens of the terminals it runs
// and the server's gateway resolves them, so each issue and revoke crosses as
// a digest, never the token, and a restarted server is told every live one.

test('an issue and a revoke are heard by digest, and the token never leaves', () => {
  const heard: LaunchTokenChange[] = []
  const stop = onGatewayLaunchTokenChange((change) => heard.push(change))
  const token = issueGatewayLaunchToken({ workspaceId: 'ws-1', agentId: 'agent-1', cliId: 'claude' })
  revokeGatewayLaunchToken(token)
  revokeGatewayLaunchToken(token)
  stop()
  assert.equal(heard.length, 2, 'a second revoke of a gone token says nothing')
  assert.match(heard[0]!.digest, /^[0-9a-f]{64}$/)
  assert.notEqual(heard[0]!.digest, token)
  assert.deepEqual(heard[0]!.identity, { workspaceId: 'ws-1', agentId: 'agent-1', cliId: 'claude' })
  assert.deepEqual(heard[1], { digest: heard[0]!.digest, identity: null })
  assert.equal(JSON.stringify(heard).includes(token), false)
})

test('a digest applied here resolves the token it was made from, until revoked', () => {
  // The shell's side: issue, hear the digest, and take the token back locally
  // so only the applied copy can resolve it.
  let change: LaunchTokenChange | null = null
  const stop = onGatewayLaunchTokenChange((next) => {
    change ??= next
  })
  const token = issueGatewayLaunchToken({ workspaceId: 'ws-2', agentId: 'agent-2' })
  stop()
  revokeGatewayLaunchToken(token)
  assert.equal(resolveGatewayLaunchToken(token), null)

  applyGatewayLaunchTokenChange('shell', change!)
  assert.deepEqual(resolveGatewayLaunchToken(token), { workspaceId: 'ws-2', agentId: 'agent-2' })
  assert.equal(
    liveGatewayLaunchTokens().some((live) => live.digest === change!.digest),
    false,
    'a token told here is not one this process issued, so it is never told on',
  )
  applyGatewayLaunchTokenChange('shell', { digest: change!.digest, identity: null })
  assert.equal(resolveGatewayLaunchToken(token), null)
})

test('a change that is not a digest is ignored', () => {
  const before = liveGatewayLaunchTokens().length
  applyGatewayLaunchTokenChange('shell', { digest: 'not-a-digest', identity: { workspaceId: 'ws', agentId: 'a' } })
  assert.equal(liveGatewayLaunchTokens().length, before)
})

test("an issuer's replace drops only the tokens it told, never one issued here or told by another", () => {
  const digest = (value: string) => createHash('sha256').update(value).digest('hex')
  const native = issueGatewayLaunchToken({ workspaceId: 'ws-native', agentId: 'native-chat' })
  const fromShell = `selaunch_${'s'.repeat(43)}`
  const fromOwner = `selaunch_${'o'.repeat(43)}`
  const ended: string[] = []
  const stop = onGatewayLaunchTokenEnded((key) => ended.push(key))
  try {
    applyGatewayLaunchTokenChange('shell', { digest: digest(fromShell), identity: { workspaceId: 'ws', agentId: 'a' } })
    applyGatewayLaunchTokenChanges('environment-owner', {
      tokens: [{ digest: digest(fromOwner), identity: { workspaceId: 'ws', agentId: 'b' } }],
    })
    // The desktop reconnects and names none: only its own token goes.
    assert.equal(applyGatewayLaunchTokenChanges('environment-owner', { tokens: [], replace: true }), 0)
    assert.equal(resolveGatewayLaunchToken(fromOwner), null)
    assert.equal(resolveGatewayLaunchToken(native)?.agentId, 'native-chat', 'a native chat keeps its token')
    assert.equal(resolveGatewayLaunchToken(fromShell)?.agentId, 'a', "another issuer's token stays")
    assert.deepEqual(ended, [digest(fromOwner)])
    revokeGatewayLaunchToken(native)
    assert.equal(isGatewayLaunchTokenLive(digest(native)), false)
    assert.deepEqual(ended, [digest(fromOwner), digest(native)], 'a revoke here ends its connections too')
  } finally {
    stop()
    revokeGatewayLaunchToken(native)
    applyGatewayLaunchTokenChanges('shell', { tokens: [], replace: true })
  }
})

test('a digest two issuers hold ends only when the last lets it go', () => {
  const key = createHash('sha256').update('shared').digest('hex')
  const ended: string[] = []
  const stop = onGatewayLaunchTokenEnded((gone) => ended.push(gone))
  applyGatewayLaunchTokenChange('shell', { digest: key, identity: { workspaceId: 'ws', agentId: 'a' } })
  applyGatewayLaunchTokenChange('environment-owner', { digest: key, identity: { workspaceId: 'ws', agentId: 'a' } })
  applyGatewayLaunchTokenChange('shell', { digest: key, identity: null })
  assert.deepEqual(ended, [])
  applyGatewayLaunchTokenChange('environment-owner', { digest: key, identity: null })
  assert.deepEqual(ended, [key])
  stop()
})
