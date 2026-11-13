// @vitest-environment jsdom
import { expect, test } from 'vitest'

import { fakePairedStudios } from '../../../studio/environmentStudio.double'
import { createPairedChatTransport } from './pairedChat'

// Stop watching on a paired machine's chat's strip ends that machine's watch
// (`pullRequests.unwatch` on its Studio, asked by this window itself), named
// by the chat's agent there and the pull request's address, and says a
// machine that cannot take it in words.

test('Stop watching asks the machine the chat runs on', async () => {
  const api = {}
  ;(window as unknown as { api: unknown }).api = api
  const studio = fakePairedStudios(api, { 'pullRequests.unwatch': () => ({ watched: true }) })
  const transport = createPairedChatTransport({
    key: { connectionId: 'c1', workspaceId: 'rw1', agentId: 'agent-there' },
    machineName: 'mac-mini',
  })
  const url = 'https://github.com/acme/app/pull/7'
  // The view names the chat by its key here; the machine is asked by its own.
  const key = { workspaceRoot: '/Users/dev/app', workspaceId: 'here', agentId: 'here-agent' }
  expect(await transport.unwatchPullRequest!({ key, url })).toEqual({ ok: true })
  expect(studio.writes()).toEqual([
    {
      connectionId: 'c1',
      method: 'pullRequests.unwatch',
      params: { conversation: { workspaceId: 'rw1', agentId: 'agent-there' }, url },
    },
  ])
  studio.capabilities.clear()
  const refused = await transport.unwatchPullRequest!({ key, url })
  expect(refused.ok).toBe(false)
  expect(refused.ok ? '' : refused.message).toMatch(
    /mac-mini cannot stop watching .* Update SprintEngine Studio there/u,
  )
})
