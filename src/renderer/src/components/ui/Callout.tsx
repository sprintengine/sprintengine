import React, { type JSX } from 'react'

// Callout — a boxed note inside a panel's content (design-system/components/callout).
// `warning` and `danger` take the inline notice's own soft fill and role;
// `neutral`, `accent` and `success` stay content: a hairline box on the
// surface, the tone only in the title's ink. Never a tinted field for news.

export type CalloutTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

const GROUND: Record<CalloutTone, string> = {
  neutral: 'bg-[color:var(--bg-surface)]',
  accent: 'bg-[color:var(--bg-surface)]',
  success: 'bg-[color:var(--bg-surface)]',
  warning: 'bg-[color:var(--tone-warn-soft)]',
  danger: 'bg-[color:var(--tone-error-soft)]',
}

const TITLE_INK: Record<CalloutTone, string> = {
  neutral: 'text-[color:var(--text-strong)]',
  accent: 'text-[color:var(--accent-primary)]',
  success: 'text-[color:var(--tone-good)]',
  warning: 'text-[color:var(--text-strong)]',
  danger: 'text-[color:var(--text-strong)]',
}

export function Callout({
  tone = 'neutral',
  title,
  glyph,
  children,
  className,
}: {
  tone?: CalloutTone
  title?: React.ReactNode
  /** A glyph before the title, `aria-hidden`. */
  glyph?: React.ReactNode
  children?: React.ReactNode
  className?: string
}): JSX.Element {
  return (
    <div
      role={tone === 'danger' ? 'alert' : tone === 'warning' ? 'status' : 'note'}
      data-tone={tone}
      className={[
        'flex flex-col gap-1 rounded-sm border border-[color:var(--border-subtle)] px-3 py-2 text-body text-[color:var(--text-default)]',
        GROUND[tone],
        className ?? '',
      ].join(' ')}
    >
      {title !== undefined || glyph ? (
        <div className={['flex items-center gap-2 font-semibold', TITLE_INK[tone]].join(' ')}>
          {glyph}
          {title}
        </div>
      ) : null}
      {children !== undefined && children !== null ? <div className="min-w-0">{children}</div> : null}
    </div>
  )
}
