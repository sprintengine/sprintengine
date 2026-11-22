import assert from 'node:assert/strict'
import { test } from 'vitest'

import type {
  ConversationCapabilities,
  ConversationSessionActionResult,
  ConversationSessionSummary,
  ConversationStartSessionInput,
} from '../shared/conversation-runtime'
import { emptyAgentLaunchSettings } from '../shared/launch-settings'
import { emptyWorkspaceRegistryFile, toWorkspaceRegistryRecord } from '../shared/workspace-registry'
import type { Workspace } from '../shared/workspace'
import type { WorktreeDependencyInstallView } from '../shared/ipc/worktree-pool'
import { createConversationLaunchService, type ConversationLaunchServiceDeps } from './conversation-launch-service'
import { createWorkspaceRegistryService } from './workspace-registry-service'
import { createInMemoryWorkspaceRegistryStore } from './workspace-registry-store'
import { createWorkspaceSyncService } from './workspace-sync-service'
import type { ExtensionHookOutcome, ExtensionHooks } from '../server/extensions/hooks/extension-hooks'

// A phone's New chat, as main carries it out: a chat born in a worktree of its
// own, cut the way a window's New chat cuts one, and a chat that runs at the
// effort the phone picked.

function workspace(id: string, folderPath: string, extra: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name: 'Chat',
    mode: 'standard',
    folderPath,
    templateId: 'solo',
    layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
    agents: {},
    worktreeState: { containerPath: null, entries: {}, updatedAt: null },
    editorState: { openFiles: [], activeFilePath: null },
    createdAt: 1,
    ...extra,
  }
}

type WorktreeAsk = Parameters<NonNullable<ConversationLaunchServiceDeps['createWorktree']>>[0]
type SendInput = Parameters<ConversationLaunchServiceDeps['send']>[0]

const LEVELS: Record<string, string[]> = {
  'claude-code': ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
}

/** The launch over a real registry and bus, with git and the provider stood in for. */
function harness(
  options: {
    repoRoot?: string | null
    worktree?: Awaited<ReturnType<NonNullable<ConversationLaunchServiceDeps['createWorktree']>>>
    reasoningEfforts?: string[] | null
    withoutGit?: boolean
    worktrees?: Array<{ path: string; branch: string | null }> | null
    extensionHooks?: ExtensionHooks
  } = {},
) {
  let ids = 0
  const registry = createWorkspaceRegistryService({
    store: createInMemoryWorkspaceRegistryStore({
      ...emptyWorkspaceRegistryFile(1),
      revision: 1,
      workspaces: [
        toWorkspaceRegistryRecord(workspace('ws-app', '/Users/dev/app', { hostId: 'wsl:Ubuntu' }), 1),
        toWorkspaceRegistryRecord(
          workspace('ws-wt', '/Users/dev/.sprintengine-worktrees/app/login-fix', {
            worktree: { branch: 'agent/login-fix', repoRoot: '/Users/dev/app' },
          }),
          1,
        ),
        toWorkspaceRegistryRecord(workspace('ws-ssh', 'ssh://build-box/home/dev/app'), 1),
      ],
    }),
    now: () => 1000,
    newWorkspaceId: () => `ws-new-${++ids}`,
  })
  const sync = createWorkspaceSyncService({ registry, now: () => 1000 })
  const repoRootAsks: Array<{ folderPath: string; hostId: string | null }> = []
  const worktreeAsks: WorktreeAsk[] = []
  const listAsks: Array<{ repoRoot: string; hostId: string | null }> = []
  const starts: ConversationStartSessionInput[] = []
  const sends: SendInput[] = []
  const uses: string[] = []
  const capabilities = { reasoningEfforts: options.reasoningEfforts ?? null } as ConversationCapabilities
  const service = createConversationLaunchService({
    getWorkspace: (id) => registry.getRecord(id),
    getLaunchSettings: () => emptyAgentLaunchSettings(),
    writeAgent: (workspaceId, agentId, agent) => sync.updateWorkspaceAgent(workspaceId, agentId, agent, 'system'),
    listWorkspaces: () => registry.getRecords(),
    createWorkspace: (request) => {
      const created = sync.createWorkspace(request, 'system')
      return created.ok ? { ok: true, workspaceId: created.result.workspace.id } : created
    },
    removeWorkspace: (workspaceId) => {
      sync.removeWorkspace(workspaceId, 'system')
    },
    startSession: async (input) => {
      starts.push(input)
      return {
        ok: true,
        session: {
          sessionId: 'conv_1',
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          capabilities,
        } as ConversationSessionSummary,
      }
    },
    send: async (input) => {
      sends.push(input)
      return { ok: true } as ConversationSessionActionResult
    },
    reasoningLevels: (cli) => LEVELS[cli] ?? [],
    recordProjectUse: (folderPath) => {
      uses.push(folderPath)
    },
    ...(options.withoutGit
      ? {}
      : {
          getRepoRoot: async (folderPath: string, hostId: string | null) => {
            repoRootAsks.push({ folderPath, hostId })
            return options.repoRoot === undefined ? '/Users/dev/app' : options.repoRoot
          },
          createWorktree: async (input: WorktreeAsk) => {
            worktreeAsks.push(input)
            return (
              options.worktree ?? {
                ok: true as const,
                path: input.destinationPath,
                branch: input.branchName,
                baseRef: 'origin/main',
              }
            )
          },
          listWorktrees: async (repoRoot: string, hostId: string | null) => {
            listAsks.push({ repoRoot, hostId })
            return options.worktrees === undefined
              ? [
                  { path: '/Users/dev/app', branch: 'main' },
                  { path: '/Users/dev/.sprintengine-worktrees/app/login-fix', branch: 'agent/login-fix' },
                ]
              : options.worktrees
          },
        }),
    newWorktreeSuffix: () => 'K7QZ',
    newCommandId: () => 'cmd-1',
    ...(options.extensionHooks ? { extensionHooks: options.extensionHooks } : {}),
  })
  return { service, registry, repoRootAsks, worktreeAsks, listAsks, starts, sends, uses }
}

test('a new chat with a worktree is born in one cut from the project, on an agent branch under its container', async () => {
  const h = harness()
  const result = await h.service.launch({ workspaceId: 'ws-app', newChat: true, newWorktree: true, cli: 'codex' })
  assert.equal(result.ok, true, result.ok ? '' : result.message)
  assert.deepEqual(h.repoRootAsks, [{ folderPath: '/Users/dev/app', hostId: 'wsl:Ubuntu' }])
  assert.deepEqual(h.worktreeAsks, [
    {
      repoRoot: '/Users/dev/app',
      containerPath: '/Users/dev/.sprintengine-worktrees/app',
      destinationPath: '/Users/dev/.sprintengine-worktrees/app/chat-k7qz',
      branchName: 'agent/chat-k7qz',
      hostId: 'wsl:Ubuntu',
    },
  ])
})

test("the worktree chat's workspace is the worktree, marked with the project it was cut from", async () => {
  const h = harness()
  const result = await h.service.launch({ workspaceId: 'ws-app', newChat: true, newWorktree: true, cli: 'codex' })
  assert.ok(result.ok)
  const created = h.registry.getRecord(result.workspaceId)!
  assert.equal(created.folderPath, '/Users/dev/.sprintengine-worktrees/app/chat-k7qz')
  assert.deepEqual(created.worktree, { branch: 'agent/chat-k7qz', baseRef: 'origin/main', repoRoot: '/Users/dev/app' })
  assert.equal(created.hostId, 'wsl:Ubuntu')
})

test("the worktree chat's session starts in the worktree", async () => {
  const h = harness()
  const result = await h.service.launch({ workspaceId: 'ws-app', newChat: true, newWorktree: true, cli: 'codex' })
  assert.ok(result.ok)
  assert.equal(h.starts[0]?.workspaceRoot, '/Users/dev/.sprintengine-worktrees/app/chat-k7qz')
  assert.equal(h.starts[0]?.workspaceId, result.workspaceId)
})

test('a worktree chat started from a worktree chat gets a sibling worktree of the same project', async () => {
  const h = harness()
  const result = await h.service.launch({ workspaceId: 'ws-wt', newChat: true, newWorktree: true, cli: 'codex' })
  assert.ok(result.ok)
  assert.equal(h.repoRootAsks[0]?.folderPath, '/Users/dev/app')
  assert.equal(h.worktreeAsks[0]?.containerPath, '/Users/dev/.sprintengine-worktrees/app')
  assert.equal(h.registry.getRecord(result.workspaceId)?.worktree?.repoRoot, '/Users/dev/app')
})

test('a new chat without a worktree works in the project folder and cuts nothing', async () => {
  const h = harness()
  const result = await h.service.launch({ workspaceId: 'ws-app', newChat: true, cli: 'codex' })
  assert.ok(result.ok)
  assert.equal(h.worktreeAsks.length, 0)
  assert.equal(h.registry.getRecord(result.workspaceId)?.folderPath, '/Users/dev/app')
  assert.equal(h.starts[0]?.workspaceRoot, '/Users/dev/app')
})

test('a project that is not a git repository refuses the worktree, and nothing is created', async () => {
  const h = harness({ repoRoot: null })
  const before = h.registry.getRecords().length
  const result = await h.service.launch({ workspaceId: 'ws-app', newChat: true, newWorktree: true, cli: 'codex' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'worktree_unavailable')
  assert.match(result.message, /not a git repository/)
  assert.equal(h.worktreeAsks.length, 0)
  assert.equal(h.starts.length, 0)
  assert.equal(h.registry.getRecords().length, before)
})

test('a worktree git could not make refuses the launch with why', async () => {
  const h = harness({ worktree: { ok: false, message: 'branch agent/chat-k7qz already exists' } })
  const result = await h.service.launch({ workspaceId: 'ws-app', newChat: true, newWorktree: true, cli: 'codex' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'worktree_unavailable')
  assert.match(result.message, /already exists/)
  assert.equal(h.starts.length, 0)
})

test("a folder on an SSH machine is that machine's to start a chat in: refused here, without asking git", async () => {
  const h = harness()
  const result = await h.service.launch({ workspaceId: 'ws-ssh', newChat: true, newWorktree: true, cli: 'codex' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'unavailable')
  assert.equal(h.repoRootAsks.length, 0)
})

test('a Studio that cannot make worktrees refuses one rather than starting in the checkout', async () => {
  const h = harness({ withoutGit: true })
  const result = await h.service.launch({ workspaceId: 'ws-app', newChat: true, newWorktree: true, cli: 'codex' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'worktree_unavailable')
  assert.equal(h.starts.length, 0)
})

test('a worktree asked for a chat that joins a workspace is refused', async () => {
  const h = harness()
  const result = await h.service.launch({ workspaceId: 'ws-app', newWorktree: true, cli: 'codex' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'invalid_arguments')
  assert.equal(h.worktreeAsks.length, 0)
})

test("the effort is kept on the chat's agent record, as a window's New chat keeps it", async () => {
  const h = harness({ reasoningEfforts: LEVELS['claude-code'] })
  const result = await h.service.launch({ workspaceId: 'ws-app', cli: 'claude-code', reasoningEffort: 'high' })
  assert.ok(result.ok)
  const agent = h.registry.getRecord('ws-app')?.agents[result.agentId]
  assert.equal(agent?.conversationReasoningEffort, 'high')
})

test('the first message runs at the effort its provider takes', async () => {
  const h = harness({ reasoningEfforts: LEVELS['claude-code'] })
  const result = await h.service.launch({
    workspaceId: 'ws-app',
    cli: 'claude-code',
    reasoningEffort: 'max',
    prompt: 'think hard',
  })
  assert.ok(result.ok)
  assert.equal(h.sends[0]?.reasoningEffort, 'max')
})

test("a level the CLI declares and its chat provider does not run is kept, and the turn runs at the provider's default", async () => {
  const h = harness({ reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] })
  const result = await h.service.launch({ workspaceId: 'ws-app', cli: 'codex', reasoningEffort: 'ultra', prompt: 'go' })
  assert.ok(result.ok)
  assert.equal(h.registry.getRecord('ws-app')?.agents[result.agentId]?.conversationReasoningEffort, 'ultra')
  assert.equal(h.sends[0]?.reasoningEffort, undefined)
})

test("an effort outside the CLI's levels refuses the launch before anything is written", async () => {
  const h = harness({ reasoningEfforts: LEVELS['claude-code'] })
  const result = await h.service.launch({ workspaceId: 'ws-app', cli: 'claude-code', reasoningEffort: 'ultra' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'unsupported_effort')
  assert.match(result.message, /low, medium, high, xhigh, max/)
  assert.equal(h.starts.length, 0)
  assert.deepEqual(h.registry.getRecord('ws-app')?.agents, {})
})

test('a CLI that declares no levels ignores the effort', async () => {
  const h = harness({ reasoningEfforts: null })
  const result = await h.service.launch({ workspaceId: 'ws-app', cli: 'cursor', reasoningEffort: 'high', prompt: 'hi' })
  assert.ok(result.ok)
  assert.equal(h.registry.getRecord('ws-app')?.agents[result.agentId]?.conversationReasoningEffort, undefined)
  assert.equal(h.sends[0]?.reasoningEffort, undefined)
})

test('a new worktree chat carries its effort into the workspace it is born in', async () => {
  const h = harness({ reasoningEfforts: LEVELS['claude-code'] })
  const result = await h.service.launch({
    workspaceId: 'ws-app',
    newChat: true,
    newWorktree: true,
    cli: 'claude-code',
    reasoningEffort: 'low',
    prompt: 'tidy up',
  })
  assert.ok(result.ok)
  const created = h.registry.getRecord(result.workspaceId)!
  assert.equal(created.agents[result.agentId]?.conversationReasoningEffort, 'low')
  assert.equal(h.sends[0]?.reasoningEffort, 'low')
})

// A phone's New chat is a use of the project it picked, as a window's is, so
// the project pickers here and on the phone list it higher next time.
test('a new chat counts as a use of the folder it was asked for, not the worktree it was given', async () => {
  const h = harness()
  const plain = await h.service.launch({ workspaceId: 'ws-app', newChat: true, cli: 'codex' })
  assert.equal(plain.ok, true, plain.ok ? '' : plain.message)
  const cut = await h.service.launch({ workspaceId: 'ws-app', newChat: true, newWorktree: true, cli: 'codex' })
  assert.equal(cut.ok, true, cut.ok ? '' : cut.message)
  // Named by a worktree chat: the phone lists that folder as its own entry.
  const fromWorktree = await h.service.launch({ workspaceId: 'ws-wt', newChat: true, cli: 'codex' })
  assert.equal(fromWorktree.ok, true, fromWorktree.ok ? '' : fromWorktree.message)
  assert.deepEqual(h.uses, ['/Users/dev/app', '/Users/dev/app', '/Users/dev/.sprintengine-worktrees/app/login-fix'])
})

test('a chat joining a workspace, or a scheduled run, is not a use of the project', async () => {
  const h = harness()
  const joined = await h.service.launch({ workspaceId: 'ws-app', cli: 'codex' })
  assert.equal(joined.ok, true, joined.ok ? '' : joined.message)
  const run = await h.service.launch({ newChatIn: { folderPath: '/Users/dev/app' }, cli: 'codex' })
  assert.equal(run.ok, true, run.ok ? '' : run.message)
  assert.deepEqual(h.uses, [])
})

function installView(state: 'running' | 'succeeded' | 'failed'): WorktreeDependencyInstallView {
  return {
    id: 'install-1',
    repoRoot: '/Users/dev/app',
    path: '/Users/dev/.sprintengine-worktrees/app/chat-k7qz',
    branch: 'agent/chat-k7qz',
    command: 'pnpm install --frozen-lockfile',
    reason: 'first',
    state,
    startedAt: 10,
    endedAt: state === 'running' ? null : 20,
    lastLine: null,
    output: null,
    exitCode: state === 'running' ? null : state === 'succeeded' ? 0 : 1,
  }
}

function installingWorktree(settled: Promise<WorktreeDependencyInstallView | null>) {
  return {
    ok: true as const,
    path: '/Users/dev/.sprintengine-worktrees/app/chat-k7qz',
    branch: 'agent/chat-k7qz',
    baseRef: 'origin/main',
    dependencyInstall: { view: installView('running'), current: () => installView('running'), settled },
  }
}

async function settleAll(): Promise<void> {
  for (let pass = 0; pass < 10; pass += 1) await new Promise((resolve) => setImmediate(resolve))
}

test('a worktree still installing its dependencies answers at once, and the first message waits for the install', async () => {
  let end: (view: WorktreeDependencyInstallView | null) => void = () => {}
  const settled = new Promise<WorktreeDependencyInstallView | null>((resolve) => (end = resolve))
  const h = harness({ worktree: installingWorktree(settled) })
  const result = await h.service.launch({
    workspaceId: 'ws-app',
    newChat: true,
    newWorktree: true,
    cli: 'codex',
    prompt: 'Fix the login form',
  })
  assert.ok(result.ok)
  assert.equal(result.sessionId, 'conv_1', 'the chat and its session are there')
  assert.equal(result.dependencyInstall?.state, 'running')
  assert.equal(h.starts.length, 1)
  await settleAll()
  assert.equal(h.sends.length, 0, 'nothing is sent while the install runs')

  // However it ends: a failed install still starts the chat's work.
  end(installView('failed'))
  await settleAll()
  assert.equal(h.sends.length, 1)
  assert.equal(h.sends[0]?.message, 'Fix the login form')
})

test('a chat whose install the quit stopped sends nothing on the way out', async () => {
  const h = harness({ worktree: installingWorktree(Promise.resolve(null)) })
  const result = await h.service.launch({
    workspaceId: 'ws-app',
    newChat: true,
    newWorktree: true,
    cli: 'codex',
    prompt: 'Fix the login form',
  })
  assert.ok(result.ok)
  await settleAll()
  assert.deepEqual(h.sends, [])
})

// A paired desktop's New chat picks its worktree as this machine's door does:
// a name for the one cut for it, or a worktree the project already has.

test('a paired machine’s named worktree is cut under that name, and the answer says where', async () => {
  const h = harness()
  const result = await h.service.launch({
    workspaceId: 'ws-app',
    newChat: true,
    newWorktree: true,
    worktreeName: 'login-fix',
    cli: 'codex',
  })
  assert.ok(result.ok)
  assert.equal(h.worktreeAsks[0]?.destinationPath, '/Users/dev/.sprintengine-worktrees/app/login-fix-k7qz')
  assert.equal(h.worktreeAsks[0]?.branchName, 'agent/login-fix-k7qz')
  assert.deepEqual(result.worktree, {
    path: '/Users/dev/.sprintengine-worktrees/app/login-fix-k7qz',
    branch: 'agent/login-fix-k7qz',
  })
})

test('a blank worktree name is a made-up one', async () => {
  const h = harness()
  const result = await h.service.launch({
    workspaceId: 'ws-app',
    newChat: true,
    newWorktree: true,
    worktreeName: '  ',
    cli: 'codex',
  })
  assert.ok(result.ok)
  assert.equal(h.worktreeAsks[0]?.branchName, 'agent/chat-k7qz')
})

test('a new chat in an existing worktree is born in it, marked with its project, and cuts nothing', async () => {
  const h = harness()
  const result = await h.service.launch({
    workspaceId: 'ws-app',
    newChat: true,
    existingWorktreePath: '/Users/dev/.sprintengine-worktrees/app/login-fix/',
    cli: 'claude-code',
  })
  assert.ok(result.ok, result.ok ? '' : result.message)
  assert.equal(h.worktreeAsks.length, 0)
  assert.deepEqual(h.listAsks, [{ repoRoot: '/Users/dev/app', hostId: 'wsl:Ubuntu' }])
  const created = h.registry.getRecord(result.workspaceId)!
  assert.equal(created.folderPath, '/Users/dev/.sprintengine-worktrees/app/login-fix')
  assert.deepEqual(created.worktree, { branch: 'agent/login-fix', repoRoot: '/Users/dev/app' })
  assert.equal(h.starts[0]?.workspaceRoot, '/Users/dev/.sprintengine-worktrees/app/login-fix')
  assert.deepEqual(result.worktree, {
    path: '/Users/dev/.sprintengine-worktrees/app/login-fix',
    branch: 'agent/login-fix',
  })
})

test('the main worktree is the project folder, and the chat starts there with no worktree', async () => {
  const h = harness()
  const result = await h.service.launch({
    workspaceId: 'ws-app',
    newChat: true,
    existingWorktreePath: '/Users/dev/app',
    cli: 'codex',
  })
  assert.ok(result.ok)
  const created = h.registry.getRecord(result.workspaceId)!
  assert.equal(created.folderPath, '/Users/dev/app')
  assert.equal(created.worktree ?? null, null)
  assert.equal(result.worktree, undefined)
})

test('a path the repository does not list as a worktree is refused, and nothing is created', async () => {
  const h = harness()
  const before = h.registry.getRecords().length
  const result = await h.service.launch({
    workspaceId: 'ws-app',
    newChat: true,
    existingWorktreePath: '/Users/dev/elsewhere',
    cli: 'codex',
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'worktree_unavailable')
  assert.match(result.message, /not a worktree of/)
  assert.equal(h.starts.length, 0)
  assert.equal(h.registry.getRecords().length, before)
})

test('an existing worktree is refused where the worktrees cannot be read, or the folder is no repository', async () => {
  for (const options of [{ worktrees: null }, { repoRoot: null }, { withoutGit: true }]) {
    const h = harness(options)
    const result = await h.service.launch({
      workspaceId: 'ws-app',
      newChat: true,
      existingWorktreePath: '/Users/dev/.sprintengine-worktrees/app/login-fix',
      cli: 'codex',
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'worktree_unavailable')
    assert.equal(h.starts.length, 0)
  }
})

test('an existing worktree is only for a new chat, and never beside a new one', async () => {
  const h = harness()
  const joining = await h.service.launch({
    workspaceId: 'ws-app',
    existingWorktreePath: '/Users/dev/.sprintengine-worktrees/app/login-fix',
    cli: 'codex',
  })
  assert.equal(joining.ok, false)
  if (!joining.ok) assert.equal(joining.code, 'invalid_arguments')
  const both = await h.service.launch({
    workspaceId: 'ws-app',
    newChat: true,
    newWorktree: true,
    existingWorktreePath: '/Users/dev/.sprintengine-worktrees/app/login-fix',
    cli: 'codex',
  })
  assert.equal(both.ok, false)
  if (!both.ok) assert.equal(both.code, 'invalid_arguments')
  assert.equal(h.worktreeAsks.length, 0)
  assert.equal(h.starts.length, 0)
})

/** Extensions' workspace hooks, answering as `decide` says, and what they heard. */
function workspaceHooks(decide: (event: Record<string, unknown>) => 'deny' | Record<string, unknown>) {
  const before: Array<Record<string, unknown>> = []
  const after: Array<Record<string, unknown>> = []
  const hooks: ExtensionHooks = {
    wants: (point) => point === 'workspace.create.before' || point === 'workspace.create.after',
    run: async (_point, event) => {
      before.push(event as Record<string, unknown>)
      const decided = decide(event as Record<string, unknown>)
      return (
        decided === 'deny'
          ? { kind: 'deny', extensionId: 'acme.branches', displayName: 'Branches', reason: 'not here', failed: false }
          : { kind: 'continue', event: decided }
      ) as ExtensionHookOutcome<never>
    },
    notify: (_point, event) => void after.push(event as Record<string, unknown>),
    bind: () => undefined,
  }
  return { hooks, before, after }
}

// A new chat's workspace meets `workspace.create.before` before its worktree
// is cut: the hook sees the project, the branch it would be cut on and the
// base (the default branch), and may put it on another branch or base.
test('a hook sees a new worktree chat’s project and branch before the cut, and may change its branch and base', async () => {
  const w = workspaceHooks((event) => ({ ...event, branch: 'feature/login', base: 'origin/release' }))
  const h = harness({ extensionHooks: w.hooks })
  const result = await h.service.launch({ workspaceId: 'ws-app', newChat: true, newWorktree: true, cli: 'codex' })
  assert.equal(result.ok, true, result.ok ? '' : result.message)
  assert.deepEqual(w.before, [
    {
      for: 'chat',
      name: 'Chat',
      folderPath: null,
      project: '/Users/dev/app',
      worktree: true,
      branch: 'agent/chat-k7qz',
      base: null,
    },
  ])
  assert.equal(h.worktreeAsks[0]?.branchName, 'feature/login')
  assert.equal(h.worktreeAsks[0]?.baseRef, 'origin/release')
  assert.deepEqual(w.after[0], {
    for: 'chat',
    workspaceId: 'ws-new-1',
    name: 'Chat',
    folderPath: '/Users/dev/.sprintengine-worktrees/app/chat-k7qz',
    project: '/Users/dev/app',
    worktree: true,
    branch: 'feature/login',
    base: 'origin/main',
  })
})

test('a new chat’s workspace a hook refused cuts no worktree and makes nothing', async () => {
  const w = workspaceHooks(() => 'deny')
  const h = harness({ extensionHooks: w.hooks })
  const result = await h.service.launch({ workspaceId: 'ws-app', newChat: true, newWorktree: true, cli: 'codex' })
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.equal(result.code, 'refused_by_extension')
  assert.deepEqual(h.worktreeAsks, [], 'nothing cut')
  assert.deepEqual(h.starts, [])
  assert.equal(h.registry.getRecords().length, 3, 'no workspace made')
})

test('a branch or base a hook names for a worktree that already exists is not taken', async () => {
  const w = workspaceHooks((event) => ({ ...event, branch: 'feature/other', base: 'origin/other' }))
  const h = harness({ extensionHooks: w.hooks })
  const result = await h.service.launch({
    workspaceId: 'ws-app',
    newChat: true,
    existingWorktreePath: '/Users/dev/.sprintengine-worktrees/app/login-fix',
    cli: 'codex',
  })
  assert.equal(result.ok, true, result.ok ? '' : result.message)
  assert.equal(w.before[0]?.branch, 'agent/login-fix')
  assert.equal(w.before[0]?.folderPath, '/Users/dev/.sprintengine-worktrees/app/login-fix')
  assert.deepEqual(h.worktreeAsks, [])
  assert.equal(w.after[0]?.branch, 'agent/login-fix')
})
