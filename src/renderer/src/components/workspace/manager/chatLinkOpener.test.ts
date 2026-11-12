import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ChatLink } from '../../../../../shared/deep-link'
import { openChatLink, type ChatLinkOpenerDeps, type RemoteChatChoice } from './chatLinkOpener'

type Chat = { agents: Record<string, { name: string }> }

const HERE = 'env-here'
const MINI = 'env-mini'
const BOX = 'env-box'

function harness(
  chats: Record<string, Chat>,
  options: {
    holders?: Record<string, string>
    followers?: Record<string, string>
    remote?: (RemoteChatChoice & { chatId: string })[]
    localEnvironmentId?: string | null
  } = {},
) {
  const calls: string[] = []
  const deps: ChatLinkOpenerDeps = {
    localEnvironmentId: options.localEnvironmentId === undefined ? HERE : options.localEnvironmentId,
    getChat: (chatId) => chats[chatId] ?? null,
    holderOf: (chatId) => options.holders?.[chatId] ?? null,
    followerOf: (address) => options.followers?.[`${address.environmentId}:${address.chatId}`] ?? null,
    remoteChats: (link) =>
      (options.remote ?? []).filter(
        (choice) =>
          choice.chatId === link.chatId && (link.environmentId === null || choice.environmentId === link.environmentId),
      ),
    windowId: 'primary',
    moveHere: (chatId, from) => void calls.push(`move ${chatId} from ${from ?? 'nowhere'}`),
    select: (chatId) => void calls.push(`select ${chatId}`),
    revealAgent: (chatId, agentId, name) => void calls.push(`reveal ${chatId}/${agentId} ${name}`),
    several: (places) => void calls.push(`several: ${places.join(', ')}`),
    notOnThisMachine: () => void calls.push('not on this machine'),
  }
  return { deps, calls }
}

const link = (environmentId: string | null, chatId: string, agentId: string | null = null): ChatLink => ({
  kind: 'chat',
  environmentId,
  chatId,
  agentId,
})

const remoteChoice = (environmentId: string | null, chatId: string, machineName: string, calls: string[]) => ({
  environmentId,
  chatId,
  machineName,
  open: () => void calls.push(`open ${chatId} on ${machineName}`),
})

const chat: Chat = { agents: { 'agent-claude-1': { name: 'Otter' }, 'agent-codex-2': { name: 'Heron' } } }

test('a chat this window holds is selected, and nothing else happens', () => {
  const { deps, calls } = harness({ ws1: chat }, { holders: { ws1: 'primary' } })
  assert.equal(openChatLink(link(HERE, 'ws1'), deps), true)
  assert.deepEqual(calls, ['select ws1'])
})

test('the named agent of the chat comes forward after the chat is selected', () => {
  const { deps, calls } = harness({ ws1: chat }, { holders: { ws1: 'primary' } })
  openChatLink(link(HERE, 'ws1', 'agent-codex-2'), deps)
  assert.deepEqual(calls, ['select ws1', 'reveal ws1/agent-codex-2 Heron'])
})

test('an agent the chat no longer has still opens the chat', () => {
  const { deps, calls } = harness({ ws1: chat }, { holders: { ws1: 'primary' } })
  assert.equal(openChatLink(link(HERE, 'ws1', 'agent-gone'), deps), true)
  assert.deepEqual(calls, ['select ws1'])
})

test('a chat of this machine that is not here says so and selects nothing', () => {
  const { deps, calls } = harness({ ws1: chat })
  assert.equal(openChatLink(link(HERE, 'ws-elsewhere', 'agent-claude-1'), deps), false)
  assert.deepEqual(calls, ['not on this machine'])
})

test('a chat filed under a window that is not this one is moved here first', () => {
  const { deps, calls } = harness({ ws1: chat, ws2: chat }, { holders: { ws1: 'detached-a' } })
  openChatLink(link(HERE, 'ws1'), deps)
  openChatLink(link(HERE, 'ws2'), deps)
  assert.deepEqual(calls, ['move ws1 from detached-a', 'select ws1', 'move ws2 from nowhere', 'select ws2'])
})

test("another environment's chat is never this machine's chat of the same id", () => {
  const { deps, calls } = harness({ ws1: chat })
  assert.equal(openChatLink(link(MINI, 'ws1'), deps), false)
  assert.deepEqual(calls, ['not on this machine'])
})

test("a paired machine's chat opens as its row does, by its address there", () => {
  const calls: string[] = []
  const { deps } = harness(
    {},
    { remote: [remoteChoice(MINI, 'rw1', 'mac-mini', calls), remoteChoice(BOX, 'rw1', 'build-box', calls)] },
  )
  assert.equal(openChatLink(link(BOX, 'rw1'), deps), true)
  assert.equal(
    openChatLink(link(MINI, 'rw-gone'), { ...deps, notOnThisMachine: () => void calls.push('not here') }),
    false,
  )
  assert.deepEqual(calls, ['open rw1 on build-box', 'not here'])
})

test("a row here that follows a paired machine's chat opens here, before the machine's list is asked", () => {
  const calls: string[] = []
  const { deps, calls: local } = harness(
    { 'ws-follow': chat },
    { followers: { [`${MINI}:rw1`]: 'ws-follow' }, remote: [remoteChoice(MINI, 'rw1', 'mac-mini', calls)] },
  )
  assert.equal(openChatLink(link(MINI, 'rw1', 'agent-claude-1'), deps), true)
  assert.deepEqual(local, ['move ws-follow from nowhere', 'select ws-follow', 'reveal ws-follow/agent-claude-1 Otter'])
  assert.deepEqual(calls, [])
})

test('an old link that names no environment opens the one chat of that id any machine lists', () => {
  const calls: string[] = []
  const here = harness(
    { ws1: chat },
    { holders: { ws1: 'primary' }, remote: [remoteChoice(MINI, 'rw1', 'mac-mini', calls)] },
  )
  assert.equal(openChatLink(link(null, 'ws1'), here.deps), true)
  assert.equal(openChatLink(link(null, 'rw1'), here.deps), true)
  assert.deepEqual(here.calls, ['select ws1'])
  assert.deepEqual(calls, ['open rw1 on mac-mini'])
})

test('an old link several machines list a chat for opens none and names them', () => {
  const calls: string[] = []
  const { deps, calls: said } = harness(
    { ws1: chat },
    { remote: [remoteChoice(MINI, 'ws1', 'mac-mini', calls), remoteChoice(BOX, 'ws1', 'build-box', calls)] },
  )
  assert.equal(openChatLink(link(null, 'ws1'), deps), false)
  assert.deepEqual(said, ['several: this computer, mac-mini, build-box'])
  assert.deepEqual(calls, [])
})

test('an old link no machine lists a chat for says so', () => {
  const { deps, calls } = harness({ ws1: chat })
  assert.equal(openChatLink(link(null, 'ws-gone'), deps), false)
  assert.deepEqual(calls, ['not on this machine'])
})

test("while this machine's id is not known, a link is read as one that names no environment", () => {
  const { deps, calls } = harness({ ws1: chat }, { localEnvironmentId: null, holders: { ws1: 'primary' } })
  assert.equal(openChatLink(link(HERE, 'ws1'), deps), true)
  assert.deepEqual(calls, ['select ws1'])
})
