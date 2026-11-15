import assert from 'node:assert/strict'
import { test } from 'vitest'

import { toolError, toolSuccess, type McpToolRegistration } from '../../shared/modules/mcp-tools'
import { createStudioDiscovery, STUDIO_DISCOVERY_TOOLS } from './studio-discovery'

// The protocol's discovery reads are the gateway's own tools' answers: what
// they say is what a client is told, and a refusal keeps its meaning.

function tool(name: string, handler: McpToolRegistration['handler']): McpToolRegistration {
  return { name, description: name, inputSchema: { type: 'object', properties: {} }, handler }
}

const asked: Array<[string, Record<string, unknown>]> = []
const discovery = createStudioDiscovery(() => [
  tool(STUDIO_DISCOVERY_TOOLS.workspaces, async () =>
    toolSuccess({
      workspaces: [
        { id: 'ws-1', name: 'App', folderPath: '/Users/dev/app', projectHue: 210, settledAt: null },
        { name: 'no id' },
      ],
    }),
  ),
  tool(STUDIO_DISCOVERY_TOOLS.runtimes, async (args) => {
    asked.push(['runtimes', args])
    return args.cli === 'nope'
      ? toolSuccess({ error: { code: 'unknown_cli', message: 'No agent CLI "nope".' } })
      : toolSuccess({ clis: [{ id: 'claude', agentSelectable: true }, 'junk'] })
  }),
  tool(STUDIO_DISCOVERY_TOOLS.checkout, async (args) =>
    args.workspaceId === 'ws-1'
      ? toolSuccess({ workspaceId: 'ws-1', git: true, branch: 'main' })
      : toolError('unknown_workspace', 'Workspace "ws-9" is not known to the running app.'),
  ),
])

test('each read is the tool’s answer, with the rows a client cannot read left out', async () => {
  assert.deepEqual(
    (await discovery.workspaces()).map((workspace) => [workspace.id, workspace.projectHue]),
    [['ws-1', 210]],
  )
  assert.deepEqual(await discovery.runtimes(), { ok: true, value: { clis: [{ id: 'claude', agentSelectable: true }] } })
  const checkout = await discovery.checkout('ws-1')
  assert.equal(checkout.ok && checkout.value.branch, 'main')
})

test('a tool’s refusal of something this Studio does not hold is not_found; a missing tool is unavailable', async () => {
  assert.equal((await discovery.runtimes('nope')).ok, false)
  assert.deepEqual(asked.at(-1), ['runtimes', { cli: 'nope' }])
  const refused = await discovery.runtimes('nope')
  assert.equal(!refused.ok && refused.code, 'not_found')
  const unknown = await discovery.checkout('ws-9')
  assert.equal(!unknown.ok && unknown.code, 'not_found')
  const missing = await discovery.extensions('ws-1')
  assert.equal(!missing.ok && missing.code, 'unavailable')
})
