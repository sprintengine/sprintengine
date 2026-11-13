import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  CONVERSATION_APPROVAL_DECISIONS,
  CONVERSATION_REQUEST_DECISIONS,
  conciseConversationSendRequest,
  parseConversationClientMessage,
  type ConversationApprovalDecision,
  type ConversationCommand,
  type ConversationLaneSend,
  type ConversationPermanentRequestDecision,
  type ConversationRequestDecision,
  type ConversationSendRequest,
  type ConversationWireCommand,
} from '../../conversation-protocol/src/public'
import { STUDIO_CHAT_METHODS } from '../src/chat'
import type { StudioConversationKey } from '../src/key'
import type { StudioMethodParams } from '../src/methods'

// One send shape and one approval union, defined once in the conversation
// contract. The `expectExact` rows are the guarantees: each fails
// `npm run typecheck:tests` the moment a copy drifts from the contract.

type Flat<T> = { [K in keyof T]: T[K] }
type IsExact<A, B> = (<T>() => T extends Flat<A> ? 1 : 2) extends <T>() => T extends Flat<B> ? 1 : 2 ? true : false
function expectExact<A, B>(exact: IsExact<A, B>): void {
  assert.equal(exact, true)
}

type LaneSend = Omit<Extract<ConversationCommand, { kind: 'send' }>, 'kind'>

test("the lane's send and the protocol's send are the same type", () => {
  // The lane carries the contract's request as `ConversationLaneSend` says.
  expectExact<LaneSend, ConversationLaneSend>(true)
  // The Studio protocol's `conversation.send` is the lane's own send,
  // addressed; its `uploadIds` name uploads staged on the same connection.
  expectExact<Omit<StudioMethodParams<'conversation.send'>, 'key' | 'commandId'>, ConversationLaneSend>(true)
  expectExact<
    Pick<StudioMethodParams<'conversation.send'>, 'key' | 'commandId'>,
    { key: StudioConversationKey; commandId: string }
  >(true)
  // The first version's send is the lane's words and uploads.
  expectExact<
    Omit<Extract<ConversationWireCommand, { kind: 'send' }>, 'kind'>,
    Pick<ConversationLaneSend, 'message' | 'uploadIds'>
  >(true)
  // `session.send` is the request itself, addressed to the session.
  expectExact<
    Omit<StudioMethodParams<'session.send'>, 'commandId' | 'sessionId'>,
    Omit<ConversationSendRequest, 'queue'>
  >(true)
})

test('the lane says how it carries every part of the request', () => {
  expectExact<
    keyof ConversationLaneSend,
    | 'message'
    | 'localTurnId'
    | 'mentions'
    | 'composedAt'
    | 'uploadIds'
    | 'skills'
    | 'steer'
    | 'queue'
    | 'confirmedStale'
    | 'mode'
  >(true)
  // A part the request types one way is never carried as another.
  expectExact<ConversationLaneSend['mentions'], ConversationSendRequest['mentions']>(true)
  expectExact<ConversationLaneSend['skills'], string[] | undefined>(true)
  // @ts-expect-error a skill rides the lane by its id, never by a path on the sender's disk
  const byPath: ConversationLaneSend = { message: 'hi', skills: [{ id: 'review', sourcePath: '/tmp/x' }] }
  // @ts-expect-error `queue` is set or left out on the lane
  const unset: ConversationLaneSend = { message: 'hi', queue: false }
  assert.ok(byPath && unset)
})

test('one approval union: every decision, the lane splitting off the one only a newer desktop takes', () => {
  expectExact<ConversationRequestDecision | ConversationPermanentRequestDecision, ConversationApprovalDecision>(true)
  expectExact<ConversationPermanentRequestDecision, 'always'>(true)
  expectExact<Extract<ConversationCommand, { kind: 'resolveApproval' }>['decision'], ConversationApprovalDecision>(true)
  expectExact<Extract<ConversationWireCommand, { kind: 'resolveApproval' }>['decision'], ConversationRequestDecision>(
    true,
  )
  expectExact<NonNullable<StudioMethodParams<'session.respond'>['decision']>, ConversationApprovalDecision>(true)
  expectExact<StudioMethodParams<'conversation.resolveApproval'>['decision'], ConversationApprovalDecision>(true)
  assert.deepEqual([...CONVERSATION_APPROVAL_DECISIONS], ['once', 'conversation', 'always', 'deny'])
  assert.deepEqual(
    [...CONVERSATION_REQUEST_DECISIONS],
    CONVERSATION_APPROVAL_DECISIONS.filter((decision) => decision !== 'always'),
  )
})

const sessionSend = STUDIO_CHAT_METHODS['session.send'].params
const respond = STUDIO_CHAT_METHODS['session.respond'].params

test('session.send carries when a message was written, and refuses a queue it would not hold', () => {
  const sent = sessionSend({
    commandId: 'c1',
    sessionId: 's1',
    message: 'run it',
    composedAt: 1_700_000_000_000,
    confirmedStale: true,
  })
  assert.deepEqual(sent, {
    ok: true,
    params: {
      commandId: 'c1',
      sessionId: 's1',
      message: 'run it',
      composedAt: 1_700_000_000_000,
      confirmedStale: true,
    },
  })
  assert.equal(sessionSend({ commandId: 'c1', sessionId: 's1', message: 'x', composedAt: -1 }).ok, false)
  assert.equal(sessionSend({ commandId: 'c1', sessionId: 's1', message: 'x', confirmedStale: 'yes' }).ok, false)
  assert.equal(sessionSend({ commandId: 'c1', sessionId: 's1', message: 'x', queue: true }).ok, false)
})

test('every decision the union names is taken where an answer is given, and nothing else', () => {
  for (const decision of CONVERSATION_APPROVAL_DECISIONS)
    assert.equal(
      respond({ commandId: 'c1', sessionId: 's1', requestId: 'r1', approved: decision !== 'deny', decision }).ok,
      true,
      decision,
    )
  assert.equal(
    respond({ commandId: 'c1', sessionId: 's1', requestId: 'r1', approved: true, decision: 'forever' }).ok,
    false,
  )
  // The lane takes every decision too, `always` behind its capability.
  for (const decision of CONVERSATION_APPROVAL_DECISIONS)
    assert.ok(
      parseConversationClientMessage({
        type: 'command',
        commandId: 'c1',
        command: { kind: 'resolveApproval', requestId: 'r1', decision },
      }),
      decision,
    )
})

test('a concise request leaves out only what says nothing', () => {
  assert.deepEqual(
    conciseConversationSendRequest({
      message: 'hi',
      mode: 'default',
      skills: [],
      mentions: [],
      steer: false,
      localTurnId: undefined,
      composedAt: 0,
      confirmedStale: true,
    }),
    { message: 'hi', composedAt: 0, confirmedStale: true },
  )
  assert.deepEqual(conciseConversationSendRequest({ message: '', mode: 'plan', skills: [{ id: 'review' }] }), {
    message: '',
    mode: 'plan',
    skills: [{ id: 'review' }],
  })
})
