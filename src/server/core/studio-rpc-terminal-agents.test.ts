import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import { connect } from '../../../packages/client-runtime/src/public'
import { createNodeStudioPlatform, resetStudioPlatform } from '../platform/platform'
import { createStudioCore } from './studio-core'
import { createStudioGateway } from './studio-gateway'
import { createStudioRpc } from './studio-rpc'

// A session's peek card and its pull request refresh (`terminal.peek`,
// `terminal.refreshPullRequests`) through the whole composition a desktop's
// server builds: `createStudioRpc` hands them to the RPC service, the service
// to its server, the server to the router. A link that drops them leaves both
// answering `unavailable`.

let scratch = ''
let savedHome: string | undefined
beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'se-studio-terminal-agents-')))
  // The core reads and writes under the home: a home of the test's own.
  savedHome = process.env.HOME
  process.env.HOME = join(scratch, 'home')
  await mkdir(process.env.HOME, { recursive: true })
})
afterAll(async () => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  resetStudioPlatform()
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

test('the peek card and a pull request refresh reach the terminal agents through the composed Studio RPC', async () => {
  const core = createStudioCore(
    createNodeStudioPlatform({ dataDir: join(scratch, 'data'), packaged: false, version: '0.0.0-test' }),
    { role: 'server' },
  )
  const gateway = createStudioGateway(core)
  const asked: string[] = []
  const rpc = createStudioRpc(core, gateway, {
    terminalAgents: {
      peek: async (sessionId) => {
        asked.push(`peek:${sessionId}`)
        return {
          sessionId,
          source: 'live',
          first: { id: 'm1', text: 'Fix the login page', at: 1, truncatedChars: 0 },
          since: [],
        }
      },
      refreshPullRequests: async (sessionId) => {
        asked.push(`refresh:${sessionId}`)
        return sessionId === 'terminal-1'
      },
    },
  })
  const client = await connect({
    transport: rpc.shellTransport(),
    client: { name: 'Studio desktop', kind: 'desktop' },
    heartbeat: false,
  })
  try {
    const peek = await client.request('terminal.peek', { sessionId: 'chat-1' })
    assert.equal(peek.first?.text, 'Fix the login page')
    assert.deepEqual(await client.request('terminal.refreshPullRequests', { sessionId: 'terminal-1' }), { asked: true })
    assert.deepEqual(await client.request('terminal.refreshPullRequests', { sessionId: 'terminal-9' }), {
      asked: false,
    })
    assert.deepEqual(asked, ['peek:chat-1', 'refresh:terminal-1', 'refresh:terminal-9'])
  } finally {
    client.close()
    await rpc.stop().catch(() => undefined)
    await core.shutdown?.()
  }
})
