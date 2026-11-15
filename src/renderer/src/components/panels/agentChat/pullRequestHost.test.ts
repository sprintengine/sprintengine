import { expect, test } from 'vitest'

import { studioPullRequestHost } from './pullRequestHost'

// Create PR for a chat on this window's Studio: every step asked of that
// Studio (`pull-request-create`). A Studio from before does not serve it and
// is not asked; a creation it recorded, or could not, is said by `link`.

const CHAT = { workspaceId: 'ws-1', agentId: 'agent-1' }

function studio(serves: boolean, answers: Record<string, unknown>) {
  const asked: Array<[string, Record<string, unknown>]> = []
  const client = {
    supports: (capability: string) => serves && capability === 'pull-request-create',
    request: async (method: string, params: Record<string, unknown>) => {
      asked.push([method, params])
      return answers[method]
    },
  }
  return { asked, client: async () => client as never }
}

test('a Studio from before Create PR was a protocol method is not asked: no state, and no step goes', async () => {
  const { asked, client } = studio(false, {})
  const host = studioPullRequestHost(CHAT, client)
  expect(await host.state()).toBe(null)
  expect(await host.push()).toEqual({ ok: false, message: expect.stringContaining('older than this window') })
  const draft = host.draft('d1')
  expect('written' in draft && (await draft.written)).toEqual({
    ok: false,
    message: expect.stringContaining('older than this window'),
  })
  expect(asked).toEqual([])
})

test('every step names the chat, never a folder; a push and a creation carry a command id and the pin', async () => {
  const pin = { branch: 'feature/marks', headSha: 'abc1234def' }
  const { asked, client } = studio(true, {
    'pullRequests.createState': { state: { branch: 'feature/marks' } },
    'pullRequests.draft': {
      ok: false,
      code: 'text_generation_off',
      message: 'Text generation is off on this machine.',
    },
    'pullRequests.push': { ok: true, pushed: true },
    'pullRequests.create': {
      ok: true,
      kind: 'created',
      url: 'https://github.com/acme/app/pull/40',
      recorded: false,
      recordMessage: 'The pull request is open (https://github.com/acme/app/pull/40), but it could not be recorded.',
    },
  })
  const host = studioPullRequestHost(CHAT, client)
  expect(await host.state()).toEqual({ branch: 'feature/marks' })
  const draft = host.draft('d1')
  // Off is said as it is, not as a failed draft.
  expect('written' in draft && (await draft.written)).toEqual({
    ok: false,
    message: 'Text generation is off on this machine.',
  })
  expect(await host.push(pin)).toEqual({ ok: true, pushed: true })
  const created = await host.create({ title: 'feat: marks', body: 'Body' }, pin)
  expect(created).toEqual({ ok: true, kind: 'created', url: 'https://github.com/acme/app/pull/40' })
  // The Studio recorded it, or said why not: link says the same.
  expect(await host.link('https://github.com/acme/app/pull/40', 'feat: marks')).toEqual({
    ok: false,
    message: expect.stringContaining('could not be recorded'),
  })
  for (const [, params] of asked) {
    expect(params.conversation).toEqual(CHAT)
    expect(params).not.toHaveProperty('cwd')
  }
  const push = asked.find(([method]) => method === 'pullRequests.push')![1]
  const create = asked.find(([method]) => method === 'pullRequests.create')![1]
  expect(push).toMatchObject({ pin, commandId: expect.any(String) })
  expect(create).toMatchObject({ pin, title: 'feat: marks', body: 'Body', commandId: expect.any(String) })
})
