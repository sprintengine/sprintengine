import assert from 'node:assert/strict'
import { test } from 'vitest'

import type {
  ConversationApprovalDecision,
  ConversationImageAttachment,
  ConversationRespondToRequestInput,
  ConversationSendRequest,
  ConversationSendTurnInput,
} from './conversation-runtime'
import type { StudioMethodParams } from '../../packages/studio-protocol/src/methods'

// The runtime's input and the protocol's are the contract's send and approval
// answer with their addressing, nothing hand-copied: each row
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
  // `session.send` is the same request, its pictures by their uploads and the
  // files sent up from the client's disk by theirs: the server swaps each for
  // what it carries (a picture, a file's path here) and nothing else.
  expectExact<
    Omit<StudioMethodParams<'session.send'>, 'commandId' | 'attachments' | 'fileUploadIds'>,
    Omit<ConversationSendTurnInput, 'commandId' | 'commandFingerprint' | 'origin' | 'subagentMessage' | 'attachments'>
  >(true)
})

test('every way of answering a permission request takes the one union', () => {
  expectExact<NonNullable<ConversationRespondToRequestInput['decision']>, ConversationApprovalDecision>(true)
})
