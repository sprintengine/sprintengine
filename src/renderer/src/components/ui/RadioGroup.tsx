import React, { useId, useRef, type JSX } from 'react'

import { RadioMark } from './Checkbox'
import { FOCUS_RING_CLASS } from './tokens'

// RadioGroup — a choose-one list of rows (design-system/components/radio-group),
// each with the checkbox's radio mark as its picture, a label, and an optional
// line saying what the choice means. The rows are the radios: `role="radio"`
// in a `radiogroup`, the chosen one (or the first enabled) the one tab stop,
// and the arrow keys move the choice, as a radio group does everywhere.

export type RadioGroupOption = { value: string; label: string; description?: string; disabled?: boolean }

export function RadioGroup({
  ariaLabel,
  options,
  value,
  onChange,
  orientation = 'vertical',
  disabled = false,
  readOnly = false,
  className,
}: {
  ariaLabel: string
  options: readonly RadioGroupOption[]
  /** The chosen value; null when none is. */
  value: string | null
  onChange: (value: string) => void
  orientation?: 'vertical' | 'horizontal'
  disabled?: boolean
  /** Shows the choice and takes none. */
  readOnly?: boolean
  className?: string
}): JSX.Element {
  const id = useId()
  const rows = useRef<Array<HTMLDivElement | null>>([])
  const enabled = (option: RadioGroupOption) => !disabled && !option.disabled
  const chosen = options.findIndex((option) => option.value === value)
  const stop = chosen >= 0 ? chosen : options.findIndex(enabled)

  const choose = (index: number) => {
    const option = options[index]
    if (!option || !enabled(option) || readOnly) return
    if (option.value !== value) onChange(option.value)
  }

  const move = (from: number, step: 1 | -1 | 'first' | 'last') => {
    const walk = options.map((option, index) => (enabled(option) ? index : -1)).filter((index) => index >= 0)
    if (walk.length === 0) return
    const at = walk.indexOf(from)
    const next =
      step === 'first'
        ? walk[0]!
        : step === 'last'
          ? walk[walk.length - 1]!
          : walk[(Math.max(at, 0) + step + walk.length) % walk.length]!
    rows.current[next]?.focus()
    choose(next)
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      aria-orientation={orientation}
      className={[
        'flex',
        orientation === 'horizontal' ? 'flex-row flex-wrap gap-3' : 'flex-col gap-1.5',
        className ?? '',
      ].join(' ')}
    >
      {options.map((option, index) => {
        const checked = option.value === value
        const off = !enabled(option)
        const descriptionId = option.description ? `${id}-${index}-description` : undefined
        return (
          <div
            key={option.value}
            ref={(element) => {
              rows.current[index] = element
            }}
            role="radio"
            aria-checked={checked}
            aria-disabled={off || undefined}
            aria-describedby={descriptionId}
            tabIndex={index === stop && !off ? 0 : -1}
            onClick={() => choose(index)}
            onKeyDown={(event) => {
              const step =
                event.key === 'ArrowDown' || event.key === 'ArrowRight'
                  ? 1
                  : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
                    ? -1
                    : event.key === 'Home'
                      ? 'first'
                      : event.key === 'End'
                        ? 'last'
                        : null
              if (step !== null) {
                event.preventDefault()
                move(index, step)
              } else if (event.key === ' ') {
                event.preventDefault()
                choose(index)
              }
            }}
            className={[
              'flex items-start gap-2 rounded-sm px-2 py-1 text-body text-[color:var(--text-default)]',
              off ? 'cursor-not-allowed opacity-45' : 'cursor-pointer hover:bg-[color:var(--bg-hover)]',
              FOCUS_RING_CLASS,
            ].join(' ')}
          >
            <span className="mt-1 inline-flex">
              <RadioMark checked={checked} />
            </span>
            <span className="flex min-w-0 flex-col">
              <span>{option.label}</span>
              {option.description ? (
                <span id={descriptionId} className="text-meta text-[color:var(--text-muted)]">
                  {option.description}
                </span>
              ) : null}
            </span>
          </div>
        )
      })}
    </div>
  )
}
