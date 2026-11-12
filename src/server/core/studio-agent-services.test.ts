import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import { connect } from '../../../packages/client-runtime/src/public'
import {
  STUDIO_AGENT_RUNTIMES_CAPABILITY,
  STUDIO_AGENT_SETUP_CAPABILITY,
} from '../../../packages/studio-protocol/src/public'
import { createNodeStudioPlatform, resetStudioPlatform } from '../platform/platform'
import { createStudioCore } from './studio-core'
import { createStudioGateway } from './studio-gateway'
import { createStudioRpc } from './studio-rpc'

// The agent CLIs and their setup are the core's (studio-agent-services.ts), so
// a core composed under plain Node, as the desktop's server out of process and
// a server on a WSL or SSH machine compose it, serves `agent-runtimes` and
// `agent-setup` without anything the desktop's shell hands it.

let scratch = ''
let savedHome: string | undefined

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'se-studio-agent-services-')))
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

test('a server core serves the agent CLIs and their setup, over the files in its own data directory', async () => {
  const dataDir = join(scratch, 'data')
  const core = createStudioCore(createNodeStudioPlatform({ dataDir, packaged: false, version: '0.0.0-test' }), {
    role: 'server',
  })
  const gateway = createStudioGateway(core)
  const rpc = createStudioRpc(core, gateway)
  const client = await connect({
    transport: rpc.shellTransport(),
    client: { name: 'Studio desktop', kind: 'desktop' },
    heartbeat: false,
  })
  try {
    assert.ok(client.supports(STUDIO_AGENT_RUNTIMES_CAPABILITY), 'agent-runtimes is advertised')
    assert.ok(client.supports(STUDIO_AGENT_SETUP_CAPABILITY), 'agent-setup is advertised')

    const before = await client.request('areaSkills.get', {})
    assert.deepEqual(before.enabled, ['studio-ship'])
    const changed: string[][] = []
    const off = core.agents.services.areaSkills.onChange((choices) => changed.push([...choices.enabled]))
    const after = await client.request('areaSkills.setEnabled', {
      commandId: 'enable-canvas',
      skillId: 'studio-canvas',
      enabled: true,
    })
    off()
    assert.deepEqual(after.enabled, ['studio-canvas', 'studio-ship'])
    // The core's own store took it, the one the server's mirror to the shell follows.
    assert.deepEqual(changed, [['studio-canvas', 'studio-ship']])
    const onDisk = JSON.parse(await readFile(join(dataDir, 'studio-area-skills.json'), 'utf8')) as { enabled: string[] }
    assert.deepEqual(onDisk.enabled, ['studio-canvas', 'studio-ship'])

    const builtin = await client.request('builtinSkills.list', {})
    assert.ok(Array.isArray(builtin.skills))
    // The version check is this core's: its switch answers here.
    assert.deepEqual(await client.request('cliVersions.setEnabled', { commandId: 'checks-off', enabled: false }), {
      enabled: false,
    })
  } finally {
    client.close()
    await rpc.stop().catch(() => undefined)
    await gateway.shutdown()
    await core.shutdown()
  }
})
