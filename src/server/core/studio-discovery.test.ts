import assert from 'node:assert/strict'
import { test } from 'vitest'

import { createStudioDiscovery } from './studio-discovery'

// The protocol's discovery reads are this Studio's own reads, the ones the
// gateway's tools answer from: what they say is what a client is told, a
// refusal keeps its meaning, and a client is never read another
// environment's chat through here.

const asked: unknown[][] = []
const discovery = createStudioDiscovery({
  workspaceList: {
    list: async (options) => {
      asked.push(['list', options])
      return {
        workspaces: [{ id: 'ws-1', name: 'App', folderPath: '/Users/dev/app', projectHue: 210, settledAt: null }],
        activeWorkspaceId: null,
        primaryWindowId: null,
      }
    },
  },
  cliRuntimes: {
    list: async (cli) => {
      asked.push(['runtimes', cli])
      return cli === 'nope'
        ? { ok: false, code: 'unknown_cli', message: 'No agent CLI "nope".' }
        : { ok: true, clis: [{ id: 'claude', agentSelectable: true }] }
    },
  },
  workspaceReads: {
    checkout: async (workspaceId, options) => {
      asked.push(['checkout', workspaceId, options])
      if (workspaceId === 'ws-none') return { ok: false, code: 'workspace_without_folder', message: 'No folder.' }
      return workspaceId === 'ws-1'
        ? {
            ok: true,
            checkout: { workspaceId, git: true, branch: 'main', defaultBranch: 'main', branches: [], worktrees: [] },
          }
        : { ok: false, code: 'unknown_workspace', message: `Workspace "${workspaceId}" is not known.` }
    },
    extensions: async (workspaceId, cli, options) => {
      asked.push(['extensions', workspaceId, cli, options])
      return { ok: true, extensions: { workspaceId, skills: [], servers: [] } }
    },
  },
})

test('every read is this Studio’s own, for a client outside it', async () => {
  assert.deepEqual(
    (await discovery.workspaces()).map((workspace) => [workspace.id, workspace.projectHue]),
    [['ws-1', 210]],
  )
  assert.deepEqual(await discovery.runtimes(), { ok: true, value: { clis: [{ id: 'claude', agentSelectable: true }] } })
  const checkout = await discovery.checkout('ws-1')
  assert.equal(checkout.ok && checkout.value.branch, 'main')
  const extensions = await discovery.extensions('ws-1', 'claude')
  assert.deepEqual(extensions, { ok: true, value: { workspaceId: 'ws-1', skills: [], servers: [] } })
  assert.deepEqual(asked, [
    ['list', { ownOnly: true }],
    ['runtimes', null],
    ['checkout', 'ws-1', { ownOnly: true }],
    ['extensions', 'ws-1', 'claude', { ownOnly: true }],
  ])
})

test('a refusal of something this Studio does not hold is not_found; any other is unavailable', async () => {
  const refused = await discovery.runtimes('nope')
  assert.equal(!refused.ok && refused.code, 'not_found')
  const unknown = await discovery.checkout('ws-9')
  assert.equal(!unknown.ok && unknown.code, 'not_found')
  const noFolder = await discovery.checkout('ws-none')
  assert.equal(!noFolder.ok && noFolder.code, 'unavailable')
})
