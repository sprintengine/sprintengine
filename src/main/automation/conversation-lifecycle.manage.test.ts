import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { WorkspaceRegistryActor, WorkspaceRegistryRecord } from '../../shared/workspace-registry'
import { applyWorkspaceFieldsPatch, type WorkspaceFieldsPatch } from '../../shared/workspace-sync'
import { createConversationLifecycle, createConversationListChangeFilter } from './conversation-lifecycle'
import { createConversationTools } from './conversation-tools'
import { conversationPullRequestsOf } from './tailnet/tailnet-conversation-machine'

// What the list a paired device reads says of a chat's management. A chat's
// record (`chat-lifecycle-domain.test.ts`) and Stop watching
// (`pullRequests.unwatch`) are the Studio's, never gateway tools.

function fixture(record: Partial<WorkspaceRegistryRecord> = {}) {
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
  const tools = createConversationTools({
    launch: async () => assert.fail('no chat is started here'),
    resolveAgentPermissionPreset: () => 'bypass',
    lifecycle,
  })
  return {
    stored,
    renames,
    writes,
    tools,
    tool: (name: string) => tools.find((candidate) => candidate.name === name)!,
  }
}

test('a chat’s record and Stop watching are the Studio’s, never gateway tools', () => {
  const { tools } = fixture()
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
    'conversation.pull_request_unwatch',
  ])
    assert.ok(!tools.some((tool) => tool.name === name), name)
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
