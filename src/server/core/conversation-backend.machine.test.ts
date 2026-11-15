import assert from 'node:assert/strict'
import { test } from 'vitest'

import { refuseOtherEnvironments, type ConversationBackend } from './conversation-backend'

// This process's runtime never runs a chat another environment holds: one
// whose folder is on an SSH machine (`ssh://…`), or a WSL distribution's
// (design-wsl-ssh-direct PR 3c), by its record here or, with none, its
// folder's share. Such a chat is refused in words instead of being read as a
// folder of this computer, or run on Windows.

function guard(
  platform: string,
  records: Record<string, { hostId?: string; environment?: { kind: 'wsl'; id: string } }> = {},
) {
  const calls: string[] = []
  const runtime = {
    sendTurn: async (input: { workspaceRoot?: string }) => (calls.push(`send ${input.workspaceRoot}`), { ok: true }),
    recoverTranscript: async () => (calls.push('recover'), { ok: true }),
    listSessions: () => (calls.push('list'), []),
    onEvent: () => () => undefined,
  } as unknown as ConversationBackend
  const guarded = refuseOtherEnvironments(runtime, {
    recordOf: (id) => records[id] ?? null,
    platform,
  }) as unknown as Record<string, (...args: unknown[]) => unknown>
  return { guarded, calls }
}

test('a chat on an SSH machine is refused in words; anything else reaches the runtime unchanged', async () => {
  const { guarded, calls } = guard('darwin')
  const refused = (await guarded.sendTurn!({ workspaceRoot: 'ssh://e1/home/dev/repo' })) as {
    ok: boolean
    message: string
  }
  assert.equal(refused.ok, false)
  assert.match(refused.message, /on an SSH machine/u)
  await assert.rejects(
    guarded.recoverTranscript!({ key: { workspaceRoot: 'ssh://e1/home/dev/repo' } }) as Promise<unknown>,
    /SSH machine/u,
  )
  assert.deepEqual(calls, [], 'the runtime was never asked')

  assert.deepEqual(await guarded.sendTurn!({ workspaceRoot: '/Users/dev/repo' }), { ok: true })
  assert.deepEqual(calls, ['send /Users/dev/repo'])
  assert.equal(guarded.onEvent, guarded.onEvent, 'a member read twice is the same function')
})

test("a WSL distribution's chat is refused here, by its record or its share; a share's chat This PC runs is not", async () => {
  const { guarded, calls } = guard('win32', {
    w1: { hostId: 'wsl:Ubuntu' },
    w2: { environment: { kind: 'wsl', id: 'Ubuntu' } },
    w3: { hostId: 'local' },
  })
  const drive = (await guarded.sendTurn!({ key: { workspaceId: 'w1', workspaceRoot: 'C:\\code\\repo' } })) as {
    message: string
  }
  assert.match(drive.message, /WSL: Ubuntu's/u)
  const copy = (await guarded.sendTurn!({
    key: { workspaceId: 'w2', workspaceRoot: '\\\\wsl.localhost\\Ubuntu\\home\\dev' },
  })) as {
    message: string
  }
  assert.match(copy.message, /WSL: Ubuntu's/u)
  // No record: the folder's share says.
  const share = (await guarded.sendTurn!({ key: { workspaceId: 'gone', workspaceRoot: '\\\\wsl$\\Debian\\srv' } })) as {
    message: string
  }
  assert.match(share.message, /WSL: Debian's/u)
  assert.deepEqual(calls, [])
  // Picked to run on This PC (decision R88): this runtime's.
  assert.deepEqual(
    await guarded.sendTurn!({ key: { workspaceId: 'w3', workspaceRoot: '\\\\wsl.localhost\\Ubuntu\\home\\dev' } }),
    { ok: true },
  )
  // A call that names no folder answers as the runtime does, at once.
  assert.deepEqual(guarded.listSessions!({ workspaceId: 'w1' }), [])
  assert.deepEqual(calls, ['send undefined', 'list'])
})

test('off Windows a `wsl:` id names nothing, and its chat runs here', async () => {
  const { guarded } = guard('darwin', { w1: { hostId: 'wsl:Ubuntu' } })
  assert.deepEqual(await guarded.sendTurn!({ key: { workspaceId: 'w1', workspaceRoot: '/Users/dev/repo' } }), {
    ok: true,
  })
})
