import { expect, test } from 'vitest'

import { CHAT_GRANTS, chatWelcome } from '../../../tests/chat-welcome'
import { STUDIO_SCOPES } from '../../studio-protocol/src/public'
import { negotiateChatCapabilities, type ChatCapabilities } from '../src/public'

// What a chat may offer, read from what its server said: one function for the
// window's own Studio, a paired desktop's window or another client on a
// Studio, and an embed. Tried under each grant and against a Studio that
// serves less.

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
    // Files on a keyed send and held with a queued message are staged on the
    // socket itself, and Create PR is on the chat's own Studio.
    attachFiles: true,
    hostQueueAttachments: true,
    hostPullRequests: true,
  })
})

test('the same grant sees the same controls: the owner flag decides only what the protocol keeps for owners', () => {
  const owner = studio(chatWelcome())
  const pairedWithEverything = studio(chatWelcome({ grant: { owner: false, scopes: [...STUDIO_SCOPES] } }))
  // Sign-in and Resume in terminal open a terminal on the Studio's machine: an
  // owner's methods (`terminal.open`), whatever scopes another grant holds.
  // Create PR is the chat's, on `conversation:operate`.
  expect(pairedWithEverything).toEqual({
    ...owner,
    providerSignIn: false,
    resumeInTerminal: false,
  })
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
    // What a held message carries is held only where messages are.
    ['conversation-queued-sends', ['hostQueue', 'hostQueueAttachments']],
    ['conversation-permanent-approvals', ['permanentApprovals']],
    ['conversation-checkpoints', ['checkpointRevert']],
    ['session-controls', ['agentMessages']],
    // Sending is a session's: without it the chat is followed, not driven.
    [
      'conversation-sessions',
      [
        ...OPERATIONS.filter((flag) => !['checkpointRevert', 'agentMessages'].includes(flag)),
        'attachFiles',
        'hostQueueAttachments',
        'hostPullRequests',
      ],
    ],
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

test("a paired desktop's device grant searches and lists commands by the chat's key, and opens its pull request", () => {
  // What a device's `conversation:operate` carries on the tailnet (no files:read).
  const device = studio(
    chatWelcome({
      grant: { owner: false, scopes: ['conversation:read', 'conversation:operate', 'conversation:create'] },
    }),
  )
  for (const flag of OPERATIONS) expect(device[flag], flag).toBe(true)
  expect(device).toMatchObject({
    mentions: true,
    commandList: true,
    attachFiles: true,
    hostPullRequests: true,
    hostChanges: true,
    // No terminal of that machine is reached from here (owner ruling).
    providerSignIn: false,
    resumeInTerminal: false,
  })
})
