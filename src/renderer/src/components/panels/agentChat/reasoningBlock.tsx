// The model's reasoning, one quiet block per stretch of thinking, kept at the
// point in the turn where it happened.

import { memo, useId, useLayoutEffect, useRef } from 'react'
import { RowButton } from '../../ui'
import { ConversationMarkdown, useConversationLinkContext } from './conversationLinks'
import { useConversationDisclosure } from './conversationViewState'
import { useLiveRowMotion } from './liveVisibility'
import { ChevronRightGlyph, ThoughtGlyph } from './toolRows/ToolKindGlyph'
import { reasoningPreview } from './conversationTimeline'

// The closed header previews the first line of the reasoning as plain words,
// enough to tell one block from the next without opening it; the timeline's
// working line reads the same preview for the thought it shows.
export { reasoningPreview }

// The turn's reasoning while it is still working, out in the open rather than
// behind the fold (owner ruling 2026-11-20): an agent's thinking often says
// what it is about to do and why, and its later words assume the person read
// it. A labelled box of its own, so it never reads as the reply; it follows
// the newest text down until the person scrolls up to read, and its header
// collapses it. Once the turn settles it is gone, and the same thoughts live
// on behind the fold as the quiet "Thought for …" rows below.
export const ReasoningBox = memo(function ReasoningBox({
  texts,
  live = false,
  disclosureId,
}: {
  // Each stretch of the turn's thinking so far, in the order it came.
  texts: readonly string[]
  // The model is thinking now, rather than running a step or writing.
  live?: boolean
  disclosureId: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLiveRowMotion(ref, live)
  const context = useConversationLinkContext()
  const [open, setOpen] = useConversationDisclosure(
    `${context?.workspaceId ?? ''}:${context?.agentId ?? ''}`,
    `reasoning-box:${disclosureId}`,
    true,
  )
  const bodyId = useId()
  const bodyRef = useRef<HTMLDivElement>(null)
  const atEndRef = useRef(true)
  const shown = texts.filter((text) => text.trim())
  const newest = shown.at(-1)
  const count = shown.length
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!open || !body || !atEndRef.current) return
    body.scrollTop = body.scrollHeight
  }, [count, newest, open])
  if (newest === undefined) return null
  const label = 'Reasoning'
  return (
    // As the quiet rows: how the answer was reached, left out of a copy.
    <div
      ref={ref}
      className="mb-2 rounded-sm border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)]"
      data-reasoning-box=""
      data-copy-exclude=""
    >
      <RowButton
        density="row"
        className="group/tool-row text-meta"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => {
          if (!open) atEndRef.current = true
          setOpen(!open)
        }}
      >
        <span className="flex shrink-0 text-[color:var(--text-subtle)]">
          <ThoughtGlyph />
        </span>
        <span
          className={`shrink-0 ${live ? 'chat-shimmer text-[color:var(--text-muted)]' : 'text-[color:var(--text-muted)]'}`}
        >
          {label}
          {live ? (
            <span className="chat-shimmer__glint" aria-hidden="true">
              <span className="chat-shimmer__band" data-text={label} />
            </span>
          ) : null}
        </span>
        {open ? null : (
          <span className="min-w-0 truncate text-[color:var(--text-disabled)] group-hover/tool-row:text-[color:var(--text-subtle)]">
            {reasoningPreview(newest)}
          </span>
        )}
        <ChevronRightGlyph
          className={`icon-xs ml-auto shrink-0 text-[color:var(--text-disabled)] transition-transform group-hover/tool-row:text-[color:var(--text-subtle)] ${open ? 'rotate-90' : ''}`}
        />
      </RowButton>
      {open ? (
        <div
          ref={bodyRef}
          id={bodyId}
          role="region"
          aria-label={label}
          onScroll={(event) => {
            const body = event.currentTarget
            atEndRef.current = body.scrollHeight - body.scrollTop - body.clientHeight <= 4
          }}
          className="max-h-64 overflow-y-auto px-3 pb-2 text-[color:var(--text-muted)]"
        >
          {shown.map((text, index) => (
            // A stretch of thinking per block, a gap between them where the
            // agent stopped to run a step. Space, not rules: the box's own
            // edge is the only line it draws (quiet headers, 2026-11-10).
            <div key={index} className={index ? 'mt-3' : undefined}>
              <ConversationMarkdown text={text} streaming={live && index === shown.length - 1} tone="muted" />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
})

// Closed is the resting state: reasoning is how the answer was reached, not
// the answer. The header names how long the model thought and previews what
// about; opened, the text reads as markdown inside a bounded scroll so a long
// trace cannot push the conversation a screen down. While the model is still
// thinking the header shimmers "Thinking" instead, and an opened body follows
// the new text down until the person scrolls up to read; back at the bottom,
// it follows again.
export const ReasoningBlock = memo(function ReasoningBlock({
  text,
  duration,
  live = false,
  disclosureId,
}: {
  text: string
  // How long it streamed, already worded as the turn's step durations are.
  duration?: string
  live?: boolean
  disclosureId: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLiveRowMotion(ref, live)
  const context = useConversationLinkContext()
  const [open, setOpen] = useConversationDisclosure(
    `${context?.workspaceId ?? ''}:${context?.agentId ?? ''}`,
    `thought:${disclosureId}`,
    false,
  )
  const bodyId = useId()
  const bodyRef = useRef<HTMLDivElement>(null)
  const atEndRef = useRef(true)
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!live || !open || !body || !atEndRef.current) return
    body.scrollTop = body.scrollHeight
  }, [text, live, open])
  const label = live ? 'Thinking' : duration ? `Thought for ${duration}` : 'Thought'
  const preview = open ? '' : reasoningPreview(text)
  return (
    // How the model reached its answer, not the answer: a copied transcript
    // leaves it out, as the reply's own copy does.
    <div ref={ref} className="mb-1" data-reasoning-block="" data-copy-exclude="">
      <RowButton
        density="row"
        className="group/tool-row text-meta"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => {
          // A body opened afresh starts at the newest text.
          if (!open) atEndRef.current = true
          setOpen(!open)
        }}
      >
        <span className="flex shrink-0 text-[color:var(--text-disabled)] group-hover/tool-row:text-[color:var(--text-subtle)]">
          <ThoughtGlyph />
        </span>
        <span
          className={`shrink-0 ${live ? 'chat-shimmer text-[color:var(--text-muted)]' : 'text-[color:var(--text-subtle)] group-hover/tool-row:text-[color:var(--text-muted)]'}`}
        >
          {label}
          {live ? (
            // The shimmer's bright band: a masked copy of the label (index.css).
            <span className="chat-shimmer__glint" aria-hidden="true">
              <span className="chat-shimmer__band" data-text={label} />
            </span>
          ) : null}
        </span>
        {preview ? (
          <span className="min-w-0 truncate text-[color:var(--text-disabled)] group-hover/tool-row:text-[color:var(--text-subtle)]">
            {preview}
          </span>
        ) : null}
        <ChevronRightGlyph
          className={`icon-xs ml-auto shrink-0 text-[color:var(--text-disabled)] transition-transform group-hover/tool-row:text-[color:var(--text-subtle)] ${open ? 'rotate-90' : ''}`}
        />
      </RowButton>
      {open ? (
        // An aside, not the reply: indented off a hairline rule and set in the
        // muted tone, so bold, code and lists still read as themselves without
        // the trace competing with the answer it led to.
        <div
          ref={bodyRef}
          id={bodyId}
          onScroll={(event) => {
            const body = event.currentTarget
            atEndRef.current = body.scrollHeight - body.scrollTop - body.clientHeight <= 4
          }}
          className="mb-1 ml-3 mt-0.5 max-h-96 overflow-y-auto border-l border-[color:var(--border-subtle)] pl-3 text-[color:var(--text-muted)]"
        >
          <ConversationMarkdown text={text} streaming={live} tone="muted" />
        </div>
      ) : null}
    </div>
  )
})
