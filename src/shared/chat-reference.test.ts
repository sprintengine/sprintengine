import { expect, test } from 'vitest'
import { chatLinkFor } from '../../packages/studio-protocol/src/chat-link'
import { CHAT_REFERENCE_MIME, chatReferenceMarkdown, setChatReferenceDragData } from './chat-reference'

const ENV = 'env-here'
const at = (chatId: string) => ({ environmentId: ENV, chatId })

test("a chat's reference is a link named by its title to the chat's own address", () => {
  expect(chatReferenceMarkdown('Fix the login redirect', at('ws-123'))).toBe(
    `[Fix the login redirect](sprintengine://chat/${ENV}/ws-123)`,
  )
})

test('a title is flattened, cut, and kept from ending the link early', () => {
  expect(chatReferenceMarkdown('  Plan [v2]\n release \\ notes ', at('ws-1'))).toBe(
    `[Plan \\[v2\\] release \\\\ notes](${chatLinkFor(at('ws-1'))})`,
  )
  expect(chatReferenceMarkdown('', at('ws-1'))).toBe(`[Untitled chat](${chatLinkFor(at('ws-1'))})`)
  const long = chatReferenceMarkdown('x'.repeat(200), at('ws-1'))!
  expect(long.startsWith(`[${'x'.repeat(79)}…]`)).toBe(true)
})

test('an id a link cannot carry gives no reference', () => {
  expect(chatReferenceMarkdown('Title', at('not a valid id!'))).toBeNull()
})

test("a local chat's drag carries its reference as text; a paired machine's, or one with no address, carries none", () => {
  const data = new Map<string, string>()
  const transfer = { setData: (type: string, value: string) => void data.set(type, value) }
  expect(setChatReferenceDragData(transfer, { id: 'ws-9', name: 'Release notes', remote: false, address: at('ws-9') })).toBe(
    true,
  )
  expect(data.get('text/plain')).toBe(`[Release notes](${chatLinkFor(at('ws-9'))})`)
  expect(data.get(CHAT_REFERENCE_MIME)).toBe('ws-9')
  data.clear()
  expect(setChatReferenceDragData(transfer, { id: 'ws-9', name: 'Release notes', remote: true, address: at('ws-9') })).toBe(
    false,
  )
  expect(setChatReferenceDragData(transfer, { id: 'ws-9', name: 'Release notes', remote: false, address: null })).toBe(false)
  expect(data.size).toBe(0)
})
