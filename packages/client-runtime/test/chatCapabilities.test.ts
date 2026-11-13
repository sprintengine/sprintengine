import { expect, test } from 'vitest'

import { CHAT_GRANTS, chatWelcome } from '../../../tests/chat-welcome'
import { STUDIO_SCOPES } from '../../studio-protocol/src/public'
import { negotiateChatCapabilities, type ChatCapabilities } from '../src/public'

// What a chat may offer, read from what its server said: one function for the
// window's own Studio, a paired client on a Studio, an embed and (until it is
// on the Studio protocol) a paired desktop's lane. Tried under each grant and
// against a Studio that serves less.

const studio = (welcome: ReturnType<typeof chatWelcome>) => negotiateChatCapabilities({ via: 'studio', welcome })

const OPERATIONS = [
  'operate',
  'startSession',
  'permanentApprovals',
  'quotes',
  'checkpointRevert',
  'modelSwitch',
  'mentions',
  'steer',
  'hostQueue',
  'skills',
  'agentMessages',
  'optimisticTurns',
  'reportsPreset',
] as const satisfies ReadonlyArray<keyof ChatCapabilities>

test("the window's own Studio, on the owner's grant, offers what it serves", () => {
  const owner = studio(chatWelcome())
  for (const flag of OPERATIONS) expect(owner[flag], flag).toBe(true)
  expect(owner).toMatchObject({
    commandList: true,
    keepsSideQuestions: true,
    permissionModes: true,
    hostSchedule: true,
    hostUsageLimits: true,
    hostChanges: true,
    // The socket withholds files on a keyed send and queued attachments, and
    // no method of it opens a pull request.
    attachFiles: false,
    hostQueueAttachments: false,
    hostPullRequests: false,
  })
})

test('the same grant sees the same controls: the owner flag decides none of them', () => {
  const owner = studio(chatWelcome())
  const pairedWithEverything = studio(chatWelcome({ grant: { owner: false, scopes: [...STUDIO_SCOPES] } }))
  expect(pairedWithEverything).toEqual(owner)
})

test('a paired client that may operate is offered what its scopes reach', () => {
  const paired = studio(chatWelcome({ grant: CHAT_GRANTS['paired operate'] }))
  for (const flag of OPERATIONS) expect(paired[flag], flag).toBe(true)
  expect(paired.commandList).toBe(true)
})

test('a read-only grant reads the chat and is offered no operation', () => {
  const reader = studio(chatWelcome({ grant: CHAT_GRANTS['paired read-only'] }))
  for (const flag of OPERATIONS) expect(reader[flag], flag).toBe(false)
  // What it reads is still drawn.
  expect(reader).toMatchObject({ keepsSideQuestions: true, hostChanges: true, hostUsageLimits: true })
})

test('a revoked grant is offered nothing that needs a method', () => {
  const revoked = studio(chatWelcome({ grant: CHAT_GRANTS.revoked }))
  for (const flag of [...OPERATIONS, 'commandList'] as const) expect(revoked[flag], flag).toBe(false)
})

test('a Studio that does not serve a feature is not offered it, and nothing else changes', () => {
  const full = studio(chatWelcome())
  for (const [missing, flags] of [
    ['conversation-steer-sends', ['steer']],
    ['conversation-quote-tokens', ['quotes']],
    ['conversation-queued-sends', ['hostQueue']],
    ['conversation-permanent-approvals', ['permanentApprovals']],
    ['conversation-checkpoints', ['checkpointRevert']],
    ['session-controls', ['agentMessages']],
    // Sending is a session's: without it the chat is followed, not driven.
    ['conversation-sessions', OPERATIONS.filter((flag) => !['checkpointRevert', 'agentMessages'].includes(flag))],
  ] as const) {
    const less = studio(chatWelcome({ without: [missing] }))
    const changed = (Object.keys(full) as Array<keyof ChatCapabilities>).filter((flag) => less[flag] !== full[flag])
    expect(new Set(changed), missing).toEqual(new Set(flags))
  }
})

test('a server that has said nothing yet is offered nothing', () => {
  const nothing = negotiateChatCapabilities(null)
  expect(Object.values(nothing).every((flag) => flag === false)).toBe(true)
})

test("a paired desktop's lane offers what the machine publishes and the pairing's access reaches", () => {
  const published = [
    'conversation-models',
    'conversation-steer-sends',
    'conversation-queued-sends',
    'conversation-quote-tokens',
    'conversation-file-search',
    'conversation-send-mentions',
    'conversation-message-files',
    'upload',
    'conversation-send-skills',
    'workspace-extensions',
    'chat-create-pull-request',
    'conversation-changes',
  ]
  const operate = negotiateChatCapabilities({
    via: 'paired-lane',
    capabilities: published,
    access: 'operate',
    modelCatalog: true,
  })
  expect(operate).toMatchObject({
    operate: true,
    modelSwitch: true,
    steer: true,
    hostQueue: true,
    quotes: true,
    mentions: true,
    attachFiles: true,
    skills: true,
    hostPullRequests: true,
    hostChanges: true,
    // A send there resumes a session, carries no bubble id and the list
    // names a preset only from a desktop that keeps one.
    startSession: false,
    optimisticTurns: false,
    reportsPreset: false,
  })
  // A chat listed without a model catalog has nothing to switch to.
  expect(
    negotiateChatCapabilities({ via: 'paired-lane', capabilities: published, access: 'operate', modelCatalog: false })
      .modelSwitch,
  ).toBe(false)
  const reader = negotiateChatCapabilities({
    via: 'paired-lane',
    capabilities: published,
    access: 'read',
    modelCatalog: true,
  })
  for (const flag of OPERATIONS) expect(reader[flag], flag).toBe(false)
  expect(reader.hostChanges).toBe(true)
})
