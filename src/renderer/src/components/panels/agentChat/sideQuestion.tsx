// "Side question": ask something about this chat and read the answer in a
// drawer over it, the way Claude Code's own /btw asks it in a terminal. The
// agent answers from the conversation it holds, in one reply and with no
// tools, so nothing it says can change a file. The question and the answer
// stay out of the agent's conversation, and a turn the chat is running goes on
// as it was, its queue too. Once answered, the machine the chat runs on keeps
// the exchange in the chat's transcript, where it is drawn as a marker
// (`SideQuestionMarker`) and in the scroll rail; the marker opens it here
// again. Follow-ups in the same drawer see the side questions before them;
// closing it ends the aside and calls off one still being answered.
// "Continue in a new chat" forks the chat at its newest reply with the last
// question waiting in the fork's composer, which is how an aside becomes a
// conversation of its own.

import React, { useCallback, useEffect, useRef, useState } from 'react'

import type {
  ConversationSideQuestionExchange,
  ConversationSideQuestionResult,
} from '../../../../../shared/conversation-runtime'
import { GhostButton, InlineNotice, PrimaryButton, Textarea, Tooltip, WorkingMark } from '../../ui'
import { ConversationGlyph } from '../../ui/ComposerGlyphs'
import { Drawer } from '../../ui/Drawer'
import { ConversationMarkdown } from './conversationLinks'
import type { TranscriptEntry } from './conversationProjection'
import { turnPreviewText } from './turnNavigation'

/** A side question the chat keeps, as its transcript reads it. */
export type KeptSideQuestion = Extract<TranscriptEntry, { kind: 'sideQuestion' }>

/** One question of an aside, with its answer once there is one. */
export type SideQuestionEntry = {
  id: string
  question: string
  answer?: string
  error?: string
  /** A kept answer the transcript cut short: this is its beginning. */
  truncated?: boolean
}

export type SideQuestionApi = {
  ask(input: {
    requestId: string
    question: string
    history: ConversationSideQuestionExchange[]
  }): Promise<ConversationSideQuestionResult>
  cancel(requestId: string): void
}

export type SideQuestionState = {
  open: boolean
  entries: SideQuestionEntry[]
  /** The id of the question being answered, or null. One at a time. */
  pendingId: string | null
  /** Open the drawer; with a question, ask it at once. */
  show(question?: string): void
  ask(question: string): void
  /**
   * Open a side question the chat kept, as it was answered, in place of the
   * aside the drawer held. A follow-up asked under it sees it.
   */
  reopen(kept: KeptSideQuestion): void
  /** Close the drawer and let the aside go, calling off a question still out. */
  close(): void
}

let sideQuestionCounter = 0
function newSideQuestionId(): string {
  sideQuestionCounter += 1
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  return `side-${sideQuestionCounter}-${random}`
}

/**
 * The aside's lifecycle, apart from how it is drawn. Every close starts a new
 * generation: an answer that arrives for an aside already let go is dropped,
 * never shown in the next one.
 */
export function useSideQuestion(api: SideQuestionApi | null): SideQuestionState {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<SideQuestionEntry[]>([])
  const [pendingId, setPendingId] = useState<string | null>(null)
  const generation = useRef(0)
  const pendingRef = useRef<string | null>(null)
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  const apiRef = useRef(api)
  apiRef.current = api

  const ask = useCallback((text: string) => {
    const question = text.trim()
    const current = apiRef.current
    if (!question || !current || pendingRef.current) return
    const id = newSideQuestionId()
    const asked = generation.current
    const history = entriesRef.current.flatMap((entry) =>
      entry.answer !== undefined ? [{ question: entry.question, answer: entry.answer }] : [],
    )
    pendingRef.current = id
    setPendingId(id)
    setEntries((list) => [...list, { id, question }])
    const settle = (patch: Partial<SideQuestionEntry>) => {
      if (generation.current !== asked) return
      pendingRef.current = null
      setPendingId(null)
      setEntries((list) => list.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)))
    }
    current
      .ask({ requestId: id, question, history })
      .then((result) => {
        if (result.ok) settle({ answer: result.answer })
        else if (result.cancelled) settle({ error: 'Called off before it was answered.' })
        else settle({ error: result.message })
      })
      .catch((error: unknown) =>
        settle({ error: error instanceof Error ? error.message : 'The side question was not answered.' }),
      )
  }, [])

  // Every close and reopen starts a new generation, so an answer still out
  // for the aside let go is dropped rather than shown in the next one.
  const letGo = useCallback(() => {
    generation.current += 1
    const pending = pendingRef.current
    pendingRef.current = null
    if (pending) apiRef.current?.cancel(pending)
    setPendingId(null)
  }, [])

  const close = useCallback(() => {
    letGo()
    setEntries([])
    setOpen(false)
  }, [letGo])

  const reopen = useCallback(
    (kept: KeptSideQuestion) => {
      letGo()
      setEntries([
        {
          id: `kept-${kept.id}`,
          question: kept.question,
          answer: kept.answer,
          ...(kept.truncated ? { truncated: true } : {}),
        },
      ])
      setOpen(true)
    },
    [letGo],
  )

  const show = useCallback(
    (question?: string) => {
      setOpen(true)
      if (question?.trim()) ask(question)
    },
    [ask],
  )

  // A view that goes away takes its aside with it.
  useEffect(
    () => () => {
      generation.current += 1
      const pending = pendingRef.current
      pendingRef.current = null
      if (pending) apiRef.current?.cancel(pending)
    },
    [],
  )

  return { open, entries, pendingId, show, ask, reopen, close }
}

/** The questions of an aside that were answered, oldest first. */
function lastAnswered(entries: SideQuestionEntry[]): SideQuestionEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1)
    if (entries[index]!.answer !== undefined) return entries[index]!
  return null
}

export function SideQuestionDrawer({
  state,
  chatName,
  canAsk,
  kept,
  shortcut,
  continueInChat,
}: {
  state: SideQuestionState
  chatName: string
  /**
   * Whether the chat can be asked one now. Without it the drawer only shows a
   * side question the chat kept: a pairing that may only follow, or a chat
   * whose agent cannot answer one here.
   */
  canAsk: boolean
  /**
   * Whether the machine the chat runs on keeps an answered side question in
   * the chat. A paired machine whose Studio predates it does not, and the
   * drawer says so.
   */
  kept: boolean
  /** The chord that opens it, said in the empty drawer. */
  shortcut?: string | null
  /**
   * Fork the chat at its newest reply with the question in the fork's
   * composer. Absent where the chat cannot be forked here; `disabled` says
   * why it cannot be now.
   */
  continueInChat?: { disabled: string | null; onContinue: (question: string) => Promise<void> }
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [continuing, setContinuing] = useState(false)
  const [continueError, setContinueError] = useState<string | null>(null)
  const fieldRef = useRef<HTMLTextAreaElement | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)
  const { open, entries, pendingId } = state

  // The newest exchange in view as it is asked and as it is answered.
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [entries])
  useEffect(() => {
    if (!open) {
      setDraft('')
      setContinueError(null)
      return undefined
    }
    const frame = window.requestAnimationFrame(() => fieldRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  const submit = () => {
    if (!canAsk || !draft.trim() || pendingId) return
    state.ask(draft)
    setDraft('')
  }
  const lastKept = lastAnswered(entries)
  const continueAction =
    continueInChat && lastKept ? (
      <Tooltip
        content={
          continueInChat.disabled ?? 'Open a new chat from the newest reply, with this question ready to send there'
        }
      >
        <span>
          <GhostButton
            size="sm"
            disabled={continueInChat.disabled !== null || continuing}
            data-side-question-continue="true"
            onClick={() => {
              setContinuing(true)
              setContinueError(null)
              continueInChat
                .onContinue(lastKept.question)
                .then(() => state.close())
                .catch((error: unknown) =>
                  setContinueError(error instanceof Error ? error.message : 'The chat could not be forked.'),
                )
                .finally(() => setContinuing(false))
            }}
          >
            {continuing ? 'Forking…' : 'Continue in a new chat'}
          </GhostButton>
        </span>
      </Tooltip>
    ) : null

  return (
    <Drawer
      open={open}
      onClose={state.close}
      title="Side question"
      ariaLabel={`Side question about ${chatName}`}
      closeLabel="Close side question"
      width={440}
    >
      <Drawer.Body className="flex flex-col gap-4">
        {entries.length === 0 ? (
          <p className="text-body leading-5 text-[color:var(--text-muted)]">
            {kept
              ? 'Ask about this chat. The agent answers from the conversation so far, without tools, and its work goes on meanwhile. The question and its answer stay out of the agent’s conversation, and the chat keeps them as a side question you can open again.'
              : 'Ask about this chat. The agent answers from the conversation so far, without tools, and its work goes on meanwhile. The question and its answer stay out of the chat: the Studio on the machine it runs on does not keep side questions yet, so closing this lets them go.'}
            {shortcut ? ` ${shortcut} opens it from the composer.` : ''}
          </p>
        ) : null}
        {entries.map((entry) => (
          <section key={entry.id} className="flex flex-col gap-2" data-side-question-entry={entry.id}>
            <p className="whitespace-pre-wrap break-words text-body font-medium text-[color:var(--text-strong)]">
              {entry.question}
            </p>
            {entry.answer !== undefined ? (
              <div className="flex min-w-0 flex-col gap-2" data-side-question-answer="true">
                <ConversationMarkdown text={entry.answer} size="compact" />
                {entry.truncated ? (
                  <p className="text-meta text-[color:var(--text-muted)]">
                    The answer was longer than the chat keeps; this is its beginning.
                  </p>
                ) : null}
              </div>
            ) : entry.error !== undefined ? (
              <InlineNotice tone="error" title={entry.error} />
            ) : (
              <p role="status" className="flex items-center gap-2 text-meta text-[color:var(--text-muted)]">
                <WorkingMark label="Answering" />
                Answering…
              </p>
            )}
          </section>
        ))}
        <div ref={endRef} />
      </Drawer.Body>
      {/* No rule above the field: the drawer is an overlay, and its body is a
          ScrollArea whose bottom edge fades while earlier answers sit below
          the fold. Answers arrive whole, never streamed, so the fade is not
          recomposited per token. */}
      {canAsk ? (
        <div className="flex shrink-0 flex-col gap-2 px-3 py-3">
          <Textarea
            ref={fieldRef}
            rows={3}
            resize="none"
            value={draft}
            aria-label="Side question"
            placeholder={entries.length ? 'Ask a follow-up' : 'Ask a side question'}
            data-side-question-input="true"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                submit()
              }
            }}
          />
          {continueError ? <InlineNotice tone="error" title={continueError} /> : null}
          <div className="flex items-center gap-2">
            {continueAction}
            <span className="flex-1" />
            <PrimaryButton
              size="sm"
              disabled={!draft.trim() || pendingId !== null}
              aria-keyshortcuts="Enter"
              data-side-question-ask="true"
              onClick={submit}
            >
              Ask
            </PrimaryButton>
          </div>
        </div>
      ) : (
        <p className="shrink-0 px-3 py-3 text-meta text-[color:var(--text-muted)]" data-side-question-read-only="true">
          This chat cannot be asked a side question from here now.
        </p>
      )}
    </Drawer>
  )
}

/**
 * Where a kept side question was asked, in the transcript: a quiet line with
 * the question's opening words, which opens the question and its answer in
 * the drawer again. A view with no drawer (the read-only embed) opens the
 * answer under the line instead. The glyph is the composer menu's Side
 * question glyph in the warn tone, the same yellow as its notch in the scroll
 * rail, so the two read as one kind of thing and as something other than a
 * turn.
 */
export function SideQuestionMarker({
  entry,
  onOpen,
}: {
  entry: KeptSideQuestion
  onOpen?: (entry: KeptSideQuestion) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const question = turnPreviewText(entry.question, 160) ?? entry.question
  return (
    <div className="flex min-w-0 flex-col items-start gap-2 pb-6" data-side-question-marker={entry.id}>
      <GhostButton
        size="xs"
        align="start"
        className="min-w-0 max-w-full gap-1.5"
        aria-label={`Side question: ${question}`}
        {...(onOpen ? { 'aria-haspopup': 'dialog' as const } : { 'aria-expanded': expanded })}
        onClick={() => (onOpen ? onOpen(entry) : setExpanded((open) => !open))}
      >
        <ConversationGlyph className="icon-xs shrink-0 text-[color:var(--tone-warn)]" />
        <span className="shrink-0 font-medium">Side question</span>
        <span className="min-w-0 truncate text-[color:var(--text-muted)]">{question}</span>
      </GhostButton>
      {!onOpen && expanded ? (
        <div className="flex min-w-0 max-w-full flex-col gap-2 px-2" data-side-question-answer="true">
          <p className="whitespace-pre-wrap break-words text-body font-medium text-[color:var(--text-strong)]">
            {entry.question}
          </p>
          <ConversationMarkdown text={entry.answer} size="compact" />
        </div>
      ) : null}
    </div>
  )
}
