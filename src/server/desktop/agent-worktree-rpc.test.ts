import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { WorktreeDependencyInstallView } from '../../shared/ipc/worktree-pool'
import { agentWorktreesOverRpc } from './agent-worktree-rpc'
import { SERVER_METHODS } from './server-methods'

// The shell's `agent.launch` out of process: its worktree is cut by the
// server, whose pool it is, and the install that worktree started is followed
// from the shell until it ends, so the agent starts after it, as in process.

const running: WorktreeDependencyInstallView = {
  id: 'install-1',
  repoRoot: '/Users/dev/app',
  path: '/Users/dev/.sprintengine-worktrees/app/app-01',
  branch: 'agent/launched',
  command: 'npm ci',
  reason: 'first',
  state: 'running',
  startedAt: 1,
  endedAt: null,
  lastLine: null,
  output: null,
  exitCode: null,
}

function fakeRpc(answers: Record<string, (params: unknown) => Promise<unknown>>) {
  const asked: Array<[string, unknown, number | undefined]> = []
  return {
    asked,
    rpc: {
      call: async <T>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T> => {
        asked.push([method, params, options?.timeoutMs])
        const answer = answers[method]
        if (!answer) throw new Error(`no handler for ${method}`)
        return (await answer(params)) as T
      },
    },
  }
}

test('the server cuts the worktree, and the shell follows its install to the end', async () => {
  let finish!: (view: WorktreeDependencyInstallView) => void
  const { rpc, asked } = fakeRpc({
    [SERVER_METHODS.createAgentWorktree]: async () => ({
      worktreePath: running.path,
      branch: running.branch,
      dependencyInstall: running,
    }),
    [SERVER_METHODS.dependencyInstallSettled]: () => new Promise((resolve) => (finish = resolve)),
  })
  const created = await agentWorktreesOverRpc(rpc)({ workspaceRoot: '/Users/dev/app', name: 'launched' })
  assert.ok(!('error' in created))
  assert.equal(created.worktreePath, running.path)
  const install = created.dependencyInstall
  assert.ok(install, 'the running install is followed')
  assert.equal(install.current().state, 'running')
  finish({ ...running, state: 'succeeded', endedAt: 2 })
  assert.equal((await install.settled)?.state, 'succeeded')
  assert.equal(install.current().state, 'succeeded')
  assert.deepEqual(asked[1]?.slice(0, 2), [SERVER_METHODS.dependencyInstallSettled, { id: 'install-1' }])
  assert.ok((asked[1]?.[2] ?? 0) > 20 * 60_000, 'waits as long as an install may run')
})

test('a server that cannot cut it says why, and one gone mid-install starts no agent', async () => {
  const refused = fakeRpc({
    [SERVER_METHODS.createAgentWorktree]: async () => ({ error: 'Not a git repository.' }),
  })
  assert.deepEqual(await agentWorktreesOverRpc(refused.rpc)({ workspaceRoot: '/Users/dev/notes', name: 'x' }), {
    error: 'Not a git repository.',
  })
  const down = fakeRpc({})
  const answer = await agentWorktreesOverRpc(down.rpc)({ workspaceRoot: '/Users/dev/app', name: 'x' })
  assert.match('error' in answer ? answer.error : '', /no handler/)

  const lost = fakeRpc({
    [SERVER_METHODS.createAgentWorktree]: async () => ({
      worktreePath: running.path,
      branch: running.branch,
      dependencyInstall: running,
    }),
    [SERVER_METHODS.dependencyInstallSettled]: async () => {
      throw new Error('The Studio server stopped.')
    },
  })
  const created = await agentWorktreesOverRpc(lost.rpc)({ workspaceRoot: '/Users/dev/app', name: 'launched' })
  assert.ok(!('error' in created))
  assert.equal(await created.dependencyInstall?.settled, null)
})
