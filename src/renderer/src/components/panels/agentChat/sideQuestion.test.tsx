// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { ConversationSideQuestionResult } from '../../../../../shared/conversation-runtime'
import {
  SideQuestionDrawer,
  SideQuestionMarker,
  useSideQuestion,
  type KeptSideQuestion,
  type SideQuestionApi,
  type SideQuestionState,
} from './sideQuestion'

// The side question drawer's lifecycle: a question is asked with the aside's
// earlier answers, its answer is shown, closing calls off one still out and
// lets the whole aside go, and "Continue in a new chat" hands the question on.
// A side question the chat kept opens again from its marker in the transcript,
// where a follow-up leans on it, and is shown where the chat cannot be asked.

type Pending = {
  requestId: string
  question: string
  history: unknown
  settle: (r: ConversationSideQuestionResult) => void
}

let root: Root | null = null
let host: HTMLElement | null = null
let current: SideQuestionState | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
  current = null
})

function fakeApi() {
  const pending: Pending[] = []
  const cancelled: string[] = []
  const api: SideQuestionApi = {
    ask: ({ requestId, question, history }) =>
      new Promise((settle) => pending.push({ requestId, question, history, settle })),
    cancel: (requestId) => cancelled.push(requestId),
  }
  return { api, pending, cancelled }
}

function Harness({
  api,
  kept = true,
  continueInChat,
}: {
  api: SideQuestionApi | null
  kept?: boolean
  continueInChat?: React.ComponentProps<typeof SideQuestionDrawer>['continueInChat']
}) {
  const state = useSideQuestion(api)
  current = state
  return (
    <SideQuestionDrawer
      state={state}
      chatName="Atlas"
      canAsk={api !== null}
      kept={kept}
      continueInChat={continueInChat}
    />
  )
}

const keptQuestion: KeptSideQuestion = {
  kind: 'sideQuestion',
  id: 'evt-9',
  question: 'Which file is the parser in?',
  answer: 'In `src/parse.ts`.',
  createdAt: 1_700_000_000_000,
}

async function mount(element: React.ReactElement) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(element))
}

// The drawer enters over two animation frames.
const frames = () => act(async () => new Promise((resolve) => setTimeout(resolve, 50)))

async function type(text: string) {
  const field = document.querySelector<HTMLTextAreaElement>('[data-side-question-input="true"]')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

const drawerText = () => document.querySelector('[role="dialog"]')?.textContent ?? ''

test('a side question is asked, answered in the drawer, and a follow-up carries the aside before it', async () => {
  const f = fakeApi()
  await mount(<Harness api={f.api} />)
  await act(async () => current!.show('Which file is the parser in?'))
  await frames()
  expect(f.pending).toHaveLength(1)
  expect(f.pending[0]).toMatchObject({ question: 'Which file is the parser in?', history: [] })
  expect(drawerText()).toContain('Answering')
  await act(async () => f.pending[0]!.settle({ ok: true, answer: 'In `src/parse.ts`.' }))
  expect(document.querySelector('[data-side-question-answer="true"]')?.textContent).toContain('src/parse.ts')

  await type('And the tests?')
  expect(f.pending).toHaveLength(2)
  expect(f.pending[1]).toMatchObject({
    question: 'And the tests?',
    history: [{ question: 'Which file is the parser in?', answer: 'In `src/parse.ts`.' }],
  })
})

test('closing the drawer calls off the question still out and lets the aside go', async () => {
  const f = fakeApi()
  await mount(<Harness api={f.api} />)
  await act(async () => current!.show('Why?'))
  await frames()
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close side question"]')!.click())
  expect(f.cancelled).toEqual([f.pending[0]!.requestId])
  expect(current!.open).toBe(false)
  expect(current!.entries).toEqual([])
  // An answer that arrives for the closed aside is not shown in the next one.
  await act(async () => f.pending[0]!.settle({ ok: true, answer: 'Because.' }))
  await act(async () => current!.show())
  await frames()
  expect(current!.entries).toEqual([])
  expect(drawerText()).not.toContain('Because.')
  expect(drawerText()).toContain('stay out of the agent’s conversation')
  expect(drawerText()).toContain('the chat keeps them')
})

test('a machine that keeps no side questions is said to, in the empty drawer', async () => {
  const f = fakeApi()
  await mount(<Harness api={f.api} kept={false} />)
  await act(async () => current!.show())
  await frames()
  expect(drawerText()).toContain('does not keep side questions yet')
  expect(drawerText()).not.toContain('the chat keeps them')
})

test('a kept side question opens again as it was answered, and a follow-up leans on it', async () => {
  const f = fakeApi()
  await mount(<Harness api={f.api} />)
  // An aside still out when a kept question is opened is called off and let go.
  await act(async () => current!.show('Still out?'))
  await act(async () => current!.reopen(keptQuestion))
  await frames()
  expect(f.cancelled).toEqual([f.pending[0]!.requestId])
  await act(async () => f.pending[0]!.settle({ ok: true, answer: 'Too late.' }))
  expect(drawerText()).not.toContain('Too late.')
  expect(drawerText()).toContain('Which file is the parser in?')
  expect(document.querySelector('[data-side-question-answer="true"]')?.textContent).toContain('src/parse.ts')

  await type('And the tests?')
  expect(f.pending[1]).toMatchObject({
    question: 'And the tests?',
    history: [{ question: 'Which file is the parser in?', answer: 'In `src/parse.ts`.' }],
  })
})

test('a kept side question is shown where the chat cannot be asked one, without a field to ask in', async () => {
  await mount(<Harness api={null} />)
  await act(async () => current!.reopen({ ...keptQuestion, truncated: true }))
  await frames()
  expect(drawerText()).toContain('src/parse.ts')
  expect(drawerText()).toContain('longer than the chat keeps')
  expect(document.querySelector('[data-side-question-input="true"]')).toBeNull()
  expect(document.querySelector('[data-side-question-read-only="true"]')).not.toBeNull()
})

test('the marker opens the kept question, and opens it in place where there is no drawer', async () => {
  const onOpen = vi.fn()
  await mount(<SideQuestionMarker entry={keptQuestion} onOpen={onOpen} />)
  const button = () => document.querySelector<HTMLButtonElement>('[data-side-question-marker="evt-9"] button')!
  expect(button().textContent).toContain('Side question')
  expect(button().textContent).toContain('Which file is the parser in?')
  await act(async () => button().click())
  expect(onOpen).toHaveBeenCalledWith(keptQuestion)
  expect(document.querySelector('[data-side-question-answer="true"]')).toBeNull()

  await act(async () => root!.render(<SideQuestionMarker entry={keptQuestion} />))
  expect(button().getAttribute('aria-expanded')).toBe('false')
  await act(async () => button().click())
  expect(button().getAttribute('aria-expanded')).toBe('true')
  expect(document.querySelector('[data-side-question-answer="true"]')?.textContent).toContain('src/parse.ts')
})

test('one question at a time: a second is not asked while the first is answered', async () => {
  const f = fakeApi()
  await mount(<Harness api={f.api} />)
  await act(async () => current!.show('First?'))
  await act(async () => current!.ask('Second?'))
  expect(f.pending).toHaveLength(1)
  expect(current!.pendingId).toBe(f.pending[0]!.requestId)
})

test('a refusal is said in the drawer where the answer would be', async () => {
  const f = fakeApi()
  await mount(<Harness api={f.api} />)
  await act(async () => current!.show('Anything?'))
  await frames()
  await act(async () =>
    f.pending[0]!.settle({ ok: false, message: 'This version of Claude Code cannot answer side questions.' }),
  )
  expect(drawerText()).toContain('This version of Claude Code cannot answer side questions.')
  expect(current!.pendingId).toBeNull()
})

test('Continue in a new chat hands the last question to the fork and closes the aside', async () => {
  const f = fakeApi()
  const onContinue = vi.fn(async () => undefined)
  await mount(<Harness api={f.api} continueInChat={{ disabled: null, onContinue }} />)
  await act(async () => current!.show('Which file?'))
  await frames()
  // Nothing answered yet: nothing to carry on.
  expect(document.querySelector('[data-side-question-continue="true"]')).toBeNull()
  await act(async () => f.pending[0]!.settle({ ok: true, answer: 'src/parse.ts' }))
  await act(async () => document.querySelector<HTMLButtonElement>('[data-side-question-continue="true"]')!.click())
  expect(onContinue).toHaveBeenCalledWith('Which file?')
  expect(current!.open).toBe(false)
})

test('Continue in a new chat waits while the chat is working', async () => {
  const f = fakeApi()
  const onContinue = vi.fn(async () => undefined)
  await mount(<Harness api={f.api} continueInChat={{ disabled: 'Available once the chat’s turn ends', onContinue }} />)
  await act(async () => current!.show('Which file?'))
  await frames()
  await act(async () => f.pending[0]!.settle({ ok: true, answer: 'src/parse.ts' }))
  const button = document.querySelector<HTMLButtonElement>('[data-side-question-continue="true"]')!
  expect(button.disabled).toBe(true)
  await act(async () => button.click())
  expect(onContinue).not.toHaveBeenCalled()
})
