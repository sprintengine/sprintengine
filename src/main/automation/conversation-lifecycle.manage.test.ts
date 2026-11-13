import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { WorkspaceRegistryActor, WorkspaceRegistryRecord } from '../../shared/workspace-registry'
import type { McpConnectionContext } from '../../shared/modules/mcp-tools'
import { applyWorkspaceFieldsPatch, type WorkspaceFieldsPatch } from '../../shared/workspace-sync'
import { createConversationLifecycle, createConversationListChangeFilter } from './conversation-lifecycle'
import { CHAT_MANAGE_MUTATION_TOOL_NAMES, createConversationTools } from './conversation-tools'
import { isStudioGatewayMutation } from './studio-gateway-tools'
import { conversationPullRequestsOf } from './tailnet/tailnet-conversation-machine'
import { gatewayToolsForCaller, requiredScopeForTool } from './tailnet/tailnet-scopes'

// A paired desktop's Stop watching on a chat here, written to this machine's
// record as its own windows write it, and what the list a device reads says
// of a chat's management. The rest of a chat's record is the Studio's
// (`chat-lifecycle-domain.test.ts`).

const TAILNET: McpConnectionContext = { metadata: { kind: 'remote-tailnet', deviceId: 'device-1' } }
const LOCAL: McpConnectionContext = { metadata: { kind: 'external-local' } }

function fixture(record: Partial<WorkspaceRegistryRecord> = {}, watched: string[] = []) {
  const stored = { id: 'ws-1', name: 'Chat 12', createdAt: 10, ...record } as WorkspaceRegistryRecord
  const renames: Array<{ workspaceId: string; name: string; actor: WorkspaceRegistryActor }> = []
  const writes: Array<{ workspaceId: string; patch: WorkspaceFieldsPatch; actor: WorkspaceRegistryActor }> = []
  const lifecycle = createConversationLifecycle({
    getRecord: (workspaceId) => (workspaceId === stored.id ? stored : null),
    updateWorkspaceFields: (workspaceId, patch, actor) => {
      writes.push({ workspaceId, patch, actor })
      applyWorkspaceFieldsPatch(stored as unknown as Record<string, unknown>, patch)
      return { ok: true, event: {} as never }
    },
    rewindVisit: () => assert.fail('nothing here moves the visit clock'),
    isWorking: () => false,
    renameWorkspace: (workspaceId, name, actor) => {
      renames.push({ workspaceId, name, actor })
      stored.name = name
      stored.titleLocked = true
      return { ok: true, event: {} as never }
    },
  })
  const watches = new Set(watched)
  const tools = createConversationTools({
    launch: async () => assert.fail('no chat is started here'),
    resolveAgentPermissionPreset: () => 'bypass',
    lifecycle,
    pullRequestWatches: {
      watchedOf: () => [...watches],
      unwatch: (_key, url) => watches.delete(url),
    },
  })
  return {
    stored,
    renames,
    writes,
    watches,
    tools,
    tool: (name: string) => tools.find((candidate) => candidate.name === name)!,
  }
}

const errorCode = (result: { structuredContent?: unknown }) =>
  (result.structuredContent as { error: { code: string } }).error.code

test('Stop watching is a paired device’s, and not listed to an agent here; the rest of a chat’s record is the Studio’s', () => {
  const { tools } = fixture()
  const names = (context: McpConnectionContext) => gatewayToolsForCaller(tools, context).map((tool) => tool.name)
  assert.ok(names(TAILNET).includes('conversation.pull_request_unwatch'))
  assert.ok(!names(LOCAL).includes('conversation.pull_request_unwatch'))
  // Renaming, Auto compact, deleting, searching and the always-allow rules are
  // a paired device's through the Studio (`chat-lifecycle`), never tools.
  for (const name of [
    'conversation.rename',
    'conversation.auto_compact',
    'conversation.delete_plan',
    'conversation.delete',
    'conversation.search',
    'conversation.approval_rules',
    'conversation.approval_rule_revoke',
  ])
    assert.ok(!tools.some((tool) => tool.name === name), name)
})

test('Stop watching is an audited mutation needing conversation:operate', () => {
  assert.deepEqual(CHAT_MANAGE_MUTATION_TOOL_NAMES, ['conversation.pull_request_unwatch'])
  for (const name of CHAT_MANAGE_MUTATION_TOOL_NAMES) {
    assert.equal(isStudioGatewayMutation(name), true, name)
    assert.equal(requiredScopeForTool(name, true), 'conversation:operate', name)
  }
})

test('a switch of Auto compact moves the list a paired device reads', () => {
  const moves = createConversationListChangeFilter({ turnEndOf: () => undefined })
  assert.equal(
    moves({
      type: 'workspace.fields_updated',
      payload: { workspaceId: 'ws-1', patch: { autoCompactEnabled: true } },
    } as never),
    true,
  )
})

test('Stop watching ends this machine’s watch of a chat’s pull request, one or every one, and once', async () => {
  const one = 'https://github.com/acme/app/pull/7'
  const two = 'https://github.com/acme/app/pull/8'
  const f = fixture({}, [one, two])
  const tool = f.tool('conversation.pull_request_unwatch')
  const stopped = await tool.handler({ workspaceId: 'ws-1', agentId: 'agent-1', url: one }, TAILNET)
  assert.deepEqual(stopped.structuredContent, {
    ok: true,
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    stopped: 1,
    pullRequests: [one],
  })
  const again = await tool.handler({ workspaceId: 'ws-1', agentId: 'agent-1', url: one }, TAILNET)
  assert.equal((again.structuredContent as { stopped: number }).stopped, 0, 'a watch already ended changes nothing')
  const rest = await tool.handler({ workspaceId: 'ws-1', agentId: 'agent-1' }, TAILNET)
  assert.deepEqual((rest.structuredContent as { pullRequests: string[] }).pullRequests, [two])
  assert.equal(f.watches.size, 0)
  assert.equal(errorCode(await tool.handler({ workspaceId: 'ws-1' }, TAILNET)), 'invalid_arguments')
})

test('a listed pull request carries its watch', () => {
  const [listed] = conversationPullRequestsOf([
    {
      url: 'https://github.com/acme/app/pull/7',
      repoKey: 'github.com/acme/app',
      repoName: 'app',
      number: 7,
      title: 'Fix it',
      state: 'open',
      isDraft: false,
      openedAt: 1,
      stateAt: 1,
      watch: { since: 5, waitingOn: 'checks' },
    },
  ])
  assert.deepEqual(listed?.watch, { since: 5, waitingOn: 'checks' })
})
