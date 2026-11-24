// Buttons, lists and form controls of a components panel, drawn with Studio's
// own controls. Each value control follows the edit protocol (componentValue.ts):
// Studio owns what the person types, so a render never drops characters.

import { useContext, useId, useMemo, type JSX, type ReactNode } from 'react'

import type { ComponentNode } from '../../../../../../packages/extension-sdk/src/components/tree'
import {
  DangerButton,
  GhostButton,
  IconButton,
  OutlineButton,
  PrimaryButton,
  type ButtonSize,
  type IconButtonSize,
} from '../../ui/Buttons'
import { Checkbox } from '../../ui/Checkbox'
import { Input, Textarea } from '../../ui/Input'
import { RadioGroup } from '../../ui/RadioGroup'
import { RowButton } from '../../ui/RowButton'
import { Select } from '../../ui/Select'
import { Slider } from '../../ui/Slider'
import { Switch } from '../../ui/Switch'
import { toolbarItemProps, useInToolbarBand } from '../../ui/Toolbar'
import { Tooltip } from '../../ui/Tooltip'
import { componentGestureId, useGestureRef } from './componentGestures'
import { ComponentIcon } from './componentIcons'
import { useHostValue } from './componentValue'
import { callbackOf, ColumnContext, editAckOf, isMac, useComponents, usePress } from './componentsContext'

type Props = { node: ComponentNode; path: string }

const BUTTON_SIZE: Record<string, ButtonSize> = { xs: 'xs', sm: 'sm', md: 'md' }
const ICON_SIZE: Record<string, IconButtonSize> = { xs: 'xs', sm: 'sm', md: 'md' }

function withTooltip(tooltip: unknown, control: JSX.Element): JSX.Element {
  return typeof tooltip === 'string' && tooltip ? <Tooltip content={tooltip}>{control}</Tooltip> : control
}

function gestureIdOf(node: ComponentNode): string | null {
  const callback = callbackOf(node.props.onPress)
  return callback ? componentGestureId.callback(callback) : null
}

export function ButtonView({ node, path }: Props): JSX.Element {
  const view = useComponents()
  const onPress = usePress(node)
  const ref = useGestureRef(gestureIdOf(node))
  const inBand = useInToolbarBand()
  const inColumn = useContext(ColumnContext)
  const { variant = 'solid', tone, size, icon, disabled, tooltip } = node.props
  const shared = {
    ref: ref as never,
    size: BUTTON_SIZE[String(size)] ?? 'sm',
    disabled: disabled === true || !onPress,
    onClick: onPress,
    className: inColumn ? 'self-start' : undefined,
    ...toolbarItemProps(inBand),
    ...(inBand ? { tabIndex: -1 } : {}),
  }
  const content: ReactNode = (
    <>
      {typeof icon === 'string' ? <ComponentIcon name={icon} /> : null}
      {view.renderChildren(node.children, path)}
    </>
  )
  const danger = tone === 'danger'
  const control =
    variant === 'ghost' ? (
      <GhostButton {...shared} tone={danger ? 'danger' : tone === 'accent' ? 'accent' : 'neutral'}>
        {content}
      </GhostButton>
    ) : variant === 'outline' ? (
      <OutlineButton {...shared} tone={danger ? 'danger' : 'neutral'}>
        {content}
      </OutlineButton>
    ) : danger ? (
      <DangerButton {...shared}>{content}</DangerButton>
    ) : (
      <PrimaryButton {...shared}>{content}</PrimaryButton>
    )
  return withTooltip(tooltip, control)
}

export function IconButtonView({ node }: Props): JSX.Element {
  const onPress = usePress(node)
  const ref = useGestureRef(gestureIdOf(node))
  const inBand = useInToolbarBand()
  const label = String(node.props.label ?? '')
  const tooltip = typeof node.props.tooltip === 'string' && node.props.tooltip ? node.props.tooltip : label
  return (
    <Tooltip content={tooltip}>
      <IconButton
        ref={ref as never}
        aria-label={label}
        size={ICON_SIZE[String(node.props.size)] ?? 'sm'}
        tone={node.props.tone === 'danger' ? 'danger' : node.props.tone === 'accent' ? 'accent' : 'neutral'}
        disabled={node.props.disabled === true || !onPress}
        onClick={onPress}
        {...toolbarItemProps(inBand)}
        {...(inBand ? { tabIndex: -1 } : {})}
      >
        <ComponentIcon name={String(node.props.icon ?? '')} />
      </IconButton>
    </Tooltip>
  )
}

export function ListView({ node, path }: Props): JSX.Element {
  const view = useComponents()
  return (
    <ul
      aria-label={typeof node.props.label === 'string' ? node.props.label : undefined}
      className="m-0 flex list-none flex-col gap-0.5 p-0"
    >
      {view.renderChildren(node.children, path)}
    </ul>
  )
}

export function ListItemView({ node, path }: Props): JSX.Element {
  const view = useComponents()
  const onPress = usePress(node)
  const ref = useGestureRef(gestureIdOf(node))
  const { title, description, icon, current, disabled } = node.props
  const body = (
    <>
      {typeof icon === 'string' ? <ComponentIcon name={icon} /> : null}
      <span className="flex min-w-0 flex-1 flex-col">
        {typeof title === 'string' ? (
          <span className="truncate text-body text-[color:var(--text-strong)]">{title}</span>
        ) : null}
        {typeof description === 'string' ? (
          <span className="truncate text-meta text-[color:var(--text-muted)]">{description}</span>
        ) : null}
        {node.children.length > 0 ? <span className="min-w-0">{view.renderChildren(node.children, path)}</span> : null}
      </span>
    </>
  )
  return (
    <li className="min-w-0">
      {onPress ? (
        <RowButton ref={ref as never} selected={current === true} disabled={disabled === true} onClick={onPress}>
          {body}
        </RowButton>
      ) : (
        <div
          aria-current={current === true ? 'true' : undefined}
          className={[
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5',
            current === true ? 'bg-[color:var(--bg-selected)]' : '',
            disabled === true ? 'opacity-45' : '',
          ].join(' ')}
        >
          {body}
        </div>
      )}
    </li>
  )
}

/** A field's label above it, or kept as its name alone (`labelHidden`). */
function Labelled({
  id,
  label,
  hidden,
  children,
  aside,
}: {
  id: string
  label: string
  hidden: boolean
  children: ReactNode
  aside?: ReactNode
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {hidden ? null : (
        <span className="flex items-baseline justify-between gap-2">
          <label htmlFor={id} className="text-meta font-medium text-[color:var(--text-default)]">
            {label}
          </label>
          {aside}
        </span>
      )}
      {children}
    </div>
  )
}

/** The callbacks of a value control, and how an edit reaches the panel. */
function useValueSend(node: ComponentNode, change = 'onChange') {
  const view = useComponents()
  const callback = callbackOf(node.props[change])
  const send = (id: string, value: unknown, edit: number) => view.send(id, [value], edit)
  return { view, callback, send }
}

export function InputView({ node }: Props): JSX.Element {
  const id = useId()
  const { view, callback, send } = useValueSend(node)
  const state = useHostValue<string>({
    value: typeof node.props.value === 'string' ? node.props.value : undefined,
    defaultValue: typeof node.props.defaultValue === 'string' ? node.props.defaultValue : undefined,
    fallback: '',
    acked: editAckOf(node),
    callback,
    send,
  })
  const submit = callbackOf(node.props.onSubmit)
  const label = String(node.props.label ?? '')
  return (
    <Labelled id={id} label={label} hidden={node.props.labelHidden === true}>
      <Input
        id={id}
        type={node.props.type === 'password' ? 'password' : node.props.type === 'search' ? 'search' : 'text'}
        aria-label={node.props.labelHidden ? label : undefined}
        aria-invalid={node.props.invalid === true || undefined}
        value={state.value}
        readOnly={state.readOnly || view.inert}
        disabled={node.props.disabled === true}
        placeholder={typeof node.props.placeholder === 'string' ? node.props.placeholder : undefined}
        maxLength={typeof node.props.maxLength === 'number' ? node.props.maxLength : undefined}
        onChange={(event) => {
          if (!view.inert) state.change(event.currentTarget.value)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing || !submit || view.inert) return
          event.preventDefault()
          // Exactly what is on screen.
          view.send(submit, [event.currentTarget.value])
        }}
      />
    </Labelled>
  )
}

export function TextareaView({ node }: Props): JSX.Element {
  const id = useId()
  const { view, callback, send } = useValueSend(node)
  const state = useHostValue<string>({
    value: typeof node.props.value === 'string' ? node.props.value : undefined,
    defaultValue: typeof node.props.defaultValue === 'string' ? node.props.defaultValue : undefined,
    fallback: '',
    acked: editAckOf(node),
    callback,
    send,
  })
  const submit = callbackOf(node.props.onSubmit)
  const label = String(node.props.label ?? '')
  return (
    <Labelled id={id} label={label} hidden={node.props.labelHidden === true}>
      <Textarea
        id={id}
        rows={typeof node.props.rows === 'number' ? node.props.rows : 3}
        aria-label={node.props.labelHidden ? label : undefined}
        aria-invalid={node.props.invalid === true || undefined}
        value={state.value}
        readOnly={state.readOnly || view.inert}
        disabled={node.props.disabled === true}
        placeholder={typeof node.props.placeholder === 'string' ? node.props.placeholder : undefined}
        maxLength={typeof node.props.maxLength === 'number' ? node.props.maxLength : undefined}
        onChange={(event) => {
          if (!view.inert) state.change(event.currentTarget.value)
        }}
        onKeyDown={(event) => {
          const chord = isMac() ? event.metaKey : event.ctrlKey
          if (event.key !== 'Enter' || !chord || !submit || view.inert) return
          event.preventDefault()
          view.send(submit, [event.currentTarget.value])
        }}
      />
    </Labelled>
  )
}

export function SwitchView({ node }: Props): JSX.Element {
  const id = useId()
  const { view, callback, send } = useValueSend(node)
  const state = useHostValue<boolean>({
    value: typeof node.props.checked === 'boolean' ? node.props.checked : undefined,
    defaultValue: typeof node.props.defaultChecked === 'boolean' ? node.props.defaultChecked : undefined,
    fallback: false,
    acked: editAckOf(node),
    callback,
    send,
  })
  const label = String(node.props.label ?? '')
  return (
    <span className="flex items-center justify-between gap-3">
      <span id={id} className="text-body text-[color:var(--text-default)]">
        {label}
      </span>
      <Switch
        checked={state.value}
        ariaLabelledBy={id}
        disabled={node.props.disabled === true || state.readOnly}
        onChange={(next) => {
          if (!view.inert) state.change(next)
        }}
      />
    </span>
  )
}

export function CheckboxView({ node }: Props): JSX.Element {
  const { view, callback, send } = useValueSend(node)
  const state = useHostValue<boolean>({
    value: typeof node.props.checked === 'boolean' ? node.props.checked : undefined,
    defaultValue: typeof node.props.defaultChecked === 'boolean' ? node.props.defaultChecked : undefined,
    fallback: false,
    acked: editAckOf(node),
    callback,
    send,
  })
  const description = typeof node.props.description === 'string' ? node.props.description : undefined
  return (
    <Checkbox
      checked={state.value}
      disabled={node.props.disabled === true || state.readOnly}
      label={
        description ? (
          <span className="flex flex-col">
            <span>{String(node.props.label ?? '')}</span>
            <span className="text-[color:var(--text-muted)]">{description}</span>
          </span>
        ) : (
          String(node.props.label ?? '')
        )
      }
      ariaLabel={String(node.props.label ?? '')}
      onChange={(next) => {
        if (!view.inert) state.change(next)
      }}
    />
  )
}

export function SelectView({ node }: Props): JSX.Element {
  const id = useId()
  const { view, callback, send } = useValueSend(node)
  const state = useHostValue<string | null>({
    value: typeof node.props.value === 'string' ? node.props.value : undefined,
    defaultValue: typeof node.props.defaultValue === 'string' ? node.props.defaultValue : undefined,
    fallback: null,
    acked: editAckOf(node),
    callback,
    send,
  })
  const options = (node.props.options ?? []) as Array<{ value: string; label: string; disabled?: boolean }>
  const label = String(node.props.label ?? '')
  return (
    <Labelled id={id} label={label} hidden={node.props.labelHidden === true}>
      <Select
        id={id}
        ariaLabel={label}
        items={options.map((option) => ({
          value: option.value,
          label: option.label,
          ...(option.disabled ? { disabled: true } : {}),
        }))}
        value={state.value}
        disabled={node.props.disabled === true || state.readOnly}
        {...(typeof node.props.placeholder === 'string' ? { placeholder: node.props.placeholder } : {})}
        className="w-full"
        onChange={(next) => {
          if (!view.inert) state.change(next)
        }}
      />
    </Labelled>
  )
}

export function RadioGroupView({ node }: Props): JSX.Element {
  const id = useId()
  const { view, callback, send } = useValueSend(node)
  const state = useHostValue<string | null>({
    value: typeof node.props.value === 'string' ? node.props.value : undefined,
    defaultValue: typeof node.props.defaultValue === 'string' ? node.props.defaultValue : undefined,
    fallback: null,
    acked: editAckOf(node),
    callback,
    send,
  })
  const label = String(node.props.label ?? '')
  return (
    <div className="flex flex-col gap-1">
      {node.props.labelHidden ? null : (
        <span id={id} className="text-meta font-medium text-[color:var(--text-default)]">
          {label}
        </span>
      )}
      <RadioGroup
        ariaLabel={label}
        options={(node.props.options ?? []) as Array<{ value: string; label: string }>}
        value={state.value}
        orientation={node.props.orientation === 'horizontal' ? 'horizontal' : 'vertical'}
        disabled={node.props.disabled === true}
        readOnly={state.readOnly || view.inert}
        onChange={(next) => state.change(next)}
      />
    </div>
  )
}

// A Slider is drawn on the kit's stepped slider: one stop per step, at most this many.
const MAX_SLIDER_STOPS = 1001

export function SliderView({ node }: Props): JSX.Element {
  const id = useId()
  const { view, callback, send } = useValueSend(node)
  const min = typeof node.props.min === 'number' ? node.props.min : 0
  const rawMax = typeof node.props.max === 'number' ? node.props.max : 100
  const max = rawMax > min ? rawMax : min + 1
  const given = typeof node.props.step === 'number' ? node.props.step : 1
  const step = Math.max(given, (max - min) / (MAX_SLIDER_STOPS - 1))
  const stops = useMemo(() => {
    const count = Math.floor((max - min) / step + 1e-9) + 1
    return Array.from({ length: count }, (_, index) => {
      const value = Number((min + index * step).toFixed(10))
      return { id: String(value), label: String(value) }
    })
  }, [min, max, step])
  const state = useHostValue<number>({
    value: typeof node.props.value === 'number' ? node.props.value : undefined,
    defaultValue: typeof node.props.defaultValue === 'number' ? node.props.defaultValue : undefined,
    fallback: min,
    acked: editAckOf(node),
    callback,
    send,
  })
  const index = Math.max(0, Math.min(stops.length - 1, Math.round((state.value - min) / step)))
  const label = String(node.props.label ?? '')
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {node.props.labelHidden ? null : (
        <span className="flex items-baseline justify-between gap-2 text-meta">
          <span id={id} className="font-medium text-[color:var(--text-default)]">
            {label}
          </span>
          {node.props.showValue ? (
            <span className="tabular-nums text-[color:var(--text-muted)]">{stops[index]?.label}</span>
          ) : null}
        </span>
      )}
      <Slider
        stops={stops}
        value={index}
        ticks={stops.length <= 11 ? 'all' : 'none'}
        {...(node.props.labelHidden ? { ariaLabel: label } : { ariaLabelledBy: id })}
        disabled={node.props.disabled === true || state.readOnly}
        onChange={(next) => {
          if (view.inert) return
          const value = Number(stops[next]?.id ?? min)
          state.change(value)
        }}
      />
    </div>
  )
}
