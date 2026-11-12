import assert from 'node:assert/strict'
import { test } from 'vitest'

import type {
  ConversationApprovalDecision,
  ConversationImageAttachment,
  ConversationRespondToRequestInput,
  ConversationSendRequest,
  ConversationSendTurnInput,
} from './conversation-runtime'
import type { ElectronApi } from './electron-api'
import type { MeshConversationKey, MeshConversationSendInput } from './tailnet-mesh'
import type { StudioMethodParams } from '../../packages/studio-protocol/src/methods'

// The runtime's input and a paired desktop's mesh IPC are the contract's send
// and approval answer with their addressing, nothing hand-copied: each row
// fails `npm run typecheck:tests` the moment one drifts.

type Flat<T> = { [K in keyof T]: T[K] }
type IsExact<A, B> = (<T>() => T extends Flat<A> ? 1 : 2) extends <T>() => T extends Flat<B> ? 1 : 2 ? true : false
function expectExact<A, B>(exact: IsExact<A, B>): void {
  assert.equal(exact, true)
}

type Request = ConversationSendRequest<ConversationImageAttachment>

test("the runtime's input is the request with the session and what only Studio's own senders set", () => {
  expectExact<
    Omit<ConversationSendTurnInput, 'sessionId' | 'commandId' | 'commandFingerprint' | 'origin' | 'subagentMessage'>,
    Omit<Request, 'queue'>
  >(true)
  // `session.send` is the same request, its pictures by their uploads: the
  // server swaps one for the other and nothing else.
  expectExact<
    Omit<StudioMethodParams<'session.send'>, 'commandId' | 'attachments'>,
    Omit<ConversationSendTurnInput, 'commandId' | 'commandFingerprint' | 'origin' | 'subagentMessage' | 'attachments'>
  >(true)
})

test("a paired desktop's send is the request, addressed to the chat, less what the lane says its own way", () => {
  expectExact<
    MeshConversationSendInput,
    { key: MeshConversationKey } & Omit<Request, 'localTurnId' | 'reasoningEffort'>
  >(true)
  expectExact<Parameters<ElectronApi['meshConversationSend']>[0], MeshConversationSendInput>(true)
})

test('every way of answering a permission request takes the one union', () => {
  expectExact<NonNullable<ConversationRespondToRequestInput['decision']>, ConversationApprovalDecision>(true)
  expectExact<Parameters<ElectronApi['meshConversationResolveApproval']>[0]['decision'], ConversationApprovalDecision>(
    true,
  )
})
