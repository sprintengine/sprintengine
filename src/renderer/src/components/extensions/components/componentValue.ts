// The edit protocol for a components panel's value controls: Studio owns what
// the person types, so a render never drops characters.
//
// Each edit goes to the panel with an increasing number, and each render tags
// the control (`$edit`) with the newest edit the panel had handled when it
// rendered. A render that has seen every edit is the panel's word, including
// a reset to the same value it showed before ('' after a submit); one that
// lags the person's typing is an echo, and leaves what is shown alone.
//
// The count belongs to one run of the panel: a new run (a development
// folder's save, a reload) has handled none of this window's edits, so the
// count starts over with it, and its first render is the panel's word.

import { useContext, useState } from 'react'

import { ComponentsContext } from './componentsContext'

type HostValueState<T> = {
  local: T
  /** The panel's `value` and the edit it had handled, as last rendered. */
  remote: T | undefined
  acked: number
  /** The newest edit sent for this control. */
  sent: number
  /** The run these counts belong to. */
  run: string
}

export function useHostValue<T>(options: {
  value: T | undefined
  defaultValue: T | undefined
  fallback: T
  /** The newest edit the panel had handled when it rendered this control. */
  acked: number | undefined
  /** The control's change callback; absent with a `value`, the control is read-only. */
  callback: string | undefined
  send: (callback: string, value: T, edit: number) => void
}): { value: T; change: (next: T) => void; readOnly: boolean } {
  const { value, callback, send } = options
  const acked = options.acked ?? 0
  const run = useContext(ComponentsContext)?.run ?? ''
  const [state, setState] = useState<HostValueState<T>>(() => ({
    local: value ?? options.defaultValue ?? options.fallback,
    remote: value,
    acked,
    sent: 0,
    run,
  }))
  let current = state
  if (state.run !== run) {
    // A new run: nothing it rendered lags an edit of this window's, so a value it renders is its word.
    current = { local: value !== undefined ? value : state.local, remote: value, acked, sent: 0, run }
    setState(current)
  } else if (!Object.is(state.remote, value) || state.acked !== acked) {
    const caughtUp = acked >= state.sent
    current = { ...state, remote: value, acked, local: value !== undefined && caughtUp ? value : state.local }
    setState(current)
  }
  return {
    value: current.local,
    // A controlled value with no handler is the panel's to set: the person cannot edit it.
    readOnly: value !== undefined && callback === undefined,
    change: (next: T) => {
      const edit = current.sent + 1
      current = { ...current, local: next, sent: Math.max(current.sent, edit) }
      setState((previous) => ({ ...previous, local: next, sent: Math.max(previous.sent, edit) }))
      if (callback) send(callback, next, edit)
    },
  }
}
