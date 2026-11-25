// Text, content and feedback components of a components panel: what a panel
// shows rather than what a person operates (Link and Markdown links aside,
// which open only once they have stood still).

import { useEffect, useState, type JSX } from 'react'

import { copy } from '../../../../../shared/copy'
import type { ComponentNode } from '../../../../../../packages/extension-sdk/src/components/tree'
import type { RelativeTimeFormat } from '../../../../../../packages/extension-sdk/src/components/catalog'
import { Badge } from '../../ui/Badge'
import { Callout } from '../../ui/Callout'
import { CodeBlock } from '../../ui/CodeBlock'
import { DefinitionList } from '../../ui/DefinitionList'
import { EmptyState } from '../../ui/EmptyState'
import { LinkButton } from '../../ui/LinkButton'
import { Meter } from '../../ui/Meter'
import { SafeMarkdown } from '../../ui/SafeMarkdown'
import { Skeleton } from '../../ui/Skeleton'
import { Spinner } from '../../ui/Spinner'
import { componentGestureId, isComponentControlSettled, useGestureRef } from './componentGestures'
import { ComponentIcon } from './componentIcons'
import { formatRelativeTime, relativeTimeTickMs } from './componentRelativeTime'
import { appTone, callbackOf, MAX_HEIGHT_PX, textOf, toneInk, useComponents } from './componentsContext'

type Props = { node: ComponentNode; path: string }

const t = copy.extensions.components.componentsContent

const TEXT_SIZE: Record<string, string> = { xs: 'text-micro', sm: 'text-meta', md: 'text-body' }
const WEIGHT: Record<string, string> = { regular: 'font-normal', medium: 'font-medium', semibold: 'font-semibold' }

export function TextView({ node, path }: Props): JSX.Element {
  const view = useComponents()
  const { tone, muted, size, weight, truncate } = node.props
  const ink = toneInk(tone) ?? (muted ? 'var(--text-muted)' : undefined)
  return (
    <span
      className={[
        'min-w-0',
        TEXT_SIZE[String(size)] ?? '',
        WEIGHT[String(weight)] ?? '',
        truncate ? 'block truncate' : 'break-words',
        ink ? '' : 'text-[color:var(--text-default)]',
      ].join(' ')}
      style={ink ? { color: ink } : undefined}
    >
      {view.renderChildren(node.children, path)}
    </span>
  )
}

const HEADING: Record<number, { tag: 'h3' | 'h4' | 'h5'; className: string }> = {
  1: { tag: 'h3', className: 'text-heading font-semibold' },
  2: { tag: 'h4', className: 'text-body font-semibold' },
  3: { tag: 'h5', className: 'text-meta font-semibold' },
}

export function HeadingView({ node, path }: Props): JSX.Element {
  const view = useComponents()
  const { tag: Tag, className } = HEADING[Number(node.props.level ?? 1)] ?? HEADING[1]!
  return (
    <Tag className={`m-0 text-[color:var(--text-strong)] ${className}`}>{view.renderChildren(node.children, path)}</Tag>
  )
}

export function BadgeView({ node }: Props): JSX.Element {
  return <Badge tone={appTone(node.props.tone)}>{textOf(node.children)}</Badge>
}

export function CodeView_({ node }: Props): JSX.Element {
  const code = textOf(node.children)
  if (node.props.block) return <CodeBlock code={code} collapsible={false} />
  return (
    <code className="rounded-xs bg-[color:var(--bg-hover)] px-1 font-mono text-[0.92em] text-[color:var(--text-strong)]">
      {code}
    </code>
  )
}

/**
 * A Link: its `href` opens in the system browser and its `onPress` runs, but
 * only once the link has stood still. With both, the open uses the press and
 * `onPress` runs without granting the panel a second gesture.
 */
export function LinkView({ node, path }: Props): JSX.Element {
  const view = useComponents()
  const href = typeof node.props.href === 'string' ? node.props.href : undefined
  const callback = callbackOf(node.props.onPress)
  const id = href ? componentGestureId.href(href) : callback ? componentGestureId.callback(callback) : null
  const ref = useGestureRef(id)
  return (
    <LinkButton
      ref={ref as never}
      ink="accent"
      underline="hover"
      size="inherit"
      disabled={!href && !callback}
      onClick={() => {
        if (view.inert || id === null) return
        if (!isComponentControlSettled(view.gestures, id)) return
        if (href) view.openLink(href)
        else view.grantGesture()
        if (callback) view.send(callback, [])
      }}
    >
      {view.renderChildren(node.children, path)}
    </LinkButton>
  )
}

/** One of the extension's images, read through Studio; null draws the placeholder. */
function useImage(src: string | undefined): string | null | undefined {
  const view = useComponents()
  const [loaded, setLoaded] = useState<{ src: string; url: string | null } | null>(null)
  useEffect(() => {
    if (!src) return
    let live = true
    view.readImage(src).then(
      (url) => live && setLoaded({ src, url }),
      () => live && setLoaded({ src, url: null }),
    )
    return () => {
      live = false
    }
  }, [src, view])
  if (!src) return null
  return loaded?.src === src ? loaded.url : undefined
}

function MarkdownImage({ src, alt }: { src: string; alt: string }): JSX.Element {
  const url = useImage(src)
  if (!url)
    return <span className="text-[color:var(--text-muted)]">{alt ? alt : url === undefined ? '' : 'Image'}</span>
  return <img src={url} alt={alt} className="inline-block max-w-full" />
}

export function MarkdownView({ node }: Props): JSX.Element {
  const view = useComponents()
  const content = String(node.props.content ?? '')
  const id = componentGestureId.markdown(content)
  const ref = useGestureRef(id)
  return (
    <div ref={ref} className="min-w-0">
      <SafeMarkdown
        text={content}
        compact
        openLink={(href) => {
          // A link opens only once its block has stood still, and grants the panel nothing.
          if (view.inert || !isComponentControlSettled(view.gestures, id)) return
          view.openLink(href)
        }}
        image={(src, alt) => <MarkdownImage src={src} alt={alt} />}
      />
    </div>
  )
}

export function CodeViewView({ node }: Props): JSX.Element {
  const max = MAX_HEIGHT_PX[String(node.props.maxHeight ?? 'md')]
  return (
    <div
      className="min-w-0 overflow-auto"
      style={max ? { maxHeight: max } : undefined}
      data-line-numbers={node.props.lineNumbers ? 'true' : undefined}
    >
      <CodeBlock
        code={String(node.props.code ?? '')}
        {...(typeof node.props.language === 'string' ? { language: node.props.language } : {})}
        {...(typeof node.props.label === 'string' ? { filename: node.props.label } : {})}
        collapsible={false}
        // The block keeps its own wrap toggle, seeded once; a panel that changes
        // `wrap` draws it afresh so the new value shows.
        key={node.props.wrap === true ? 'wrap' : 'no-wrap'}
        defaultWrap={node.props.wrap === true}
      />
    </div>
  )
}

/** An image's width; its height follows the picture, and only `cover` crops it square. */
const IMAGE_WIDTH: Record<string, string> = {
  xs: 'w-12',
  sm: 'w-24',
  md: 'w-40',
  lg: 'w-64',
  full: 'w-full',
}

export function ImageView({ node }: Props): JSX.Element {
  const src = String(node.props.src ?? '')
  const alt = String(node.props.alt ?? '')
  const url = useImage(src)
  const width = IMAGE_WIDTH[String(node.props.size ?? 'md')] ?? IMAGE_WIDTH.md
  const cover = node.props.fit === 'cover'
  const corner = node.props.rounded ? 'rounded-md' : ''
  if (!url)
    return (
      <div
        role={alt ? 'img' : undefined}
        aria-label={alt || undefined}
        aria-hidden={alt ? undefined : true}
        data-image-placeholder=""
        className={`${width} max-w-full ${cover ? 'aspect-square' : 'aspect-video'} ${corner} flex items-center justify-center border border-dashed border-[color:var(--border-default)] text-[color:var(--text-muted)]`}
      >
        {url === undefined ? null : <ComponentIcon name="file" />}
      </div>
    )
  return (
    <img
      src={url}
      alt={alt}
      className={`${width} max-w-full ${cover ? 'aspect-square object-cover' : 'h-auto object-contain'} ${corner}`}
    />
  )
}

export function KeyValueView({ node }: Props): JSX.Element {
  const items = (node.props.items ?? []) as Array<{ label: string; value: unknown; tone?: string; code?: boolean }>
  return (
    <div aria-label={typeof node.props.label === 'string' ? node.props.label : undefined} role="group">
      <DefinitionList
        items={items.map((item, index) => {
          const text =
            item.value === null
              ? '—'
              : typeof item.value === 'boolean'
                ? item.value
                  ? t.yes
                  : t.no
                : String(item.value)
          const ink = toneInk(item.tone)
          return {
            id: undefined,
            term: item.label,
            description: (
              <span
                key={index}
                className={item.code ? 'font-mono' : undefined}
                style={ink ? { color: ink } : undefined}
              >
                {text}
              </span>
            ),
          }
        })}
      />
    </div>
  )
}

export function CalloutView({ node, path }: Props): JSX.Element {
  const view = useComponents()
  const tone = (['neutral', 'accent', 'success', 'warning', 'danger'] as const).find((each) => each === node.props.tone)
  return (
    <Callout
      tone={tone ?? 'neutral'}
      {...(typeof node.props.title === 'string' ? { title: node.props.title } : {})}
      {...(typeof node.props.icon === 'string' ? { glyph: <ComponentIcon name={node.props.icon} /> } : {})}
    >
      {node.children.length > 0 ? view.renderChildren(node.children, path) : null}
    </Callout>
  )
}

export function SkeletonView({ node }: Props): JSX.Element {
  const shape = String(node.props.shape ?? 'text')
  const label = typeof node.props.label === 'string' && node.props.label ? node.props.label : 'Loading'
  const lines = Math.max(1, Math.min(10, Number(node.props.lines ?? 3)))
  return (
    <div role="status" aria-label={label} aria-busy="true" className="flex flex-col gap-1.5">
      {shape === 'circle' ? (
        <Skeleton className="size-8 rounded-full" />
      ) : shape === 'block' ? (
        <Skeleton className="h-16 w-full rounded-sm" />
      ) : (
        Array.from({ length: lines }, (_, index) => (
          <Skeleton key={index} className={`h-3 rounded-xs ${index === lines - 1 && lines > 1 ? 'w-2/3' : 'w-full'}`} />
        ))
      )}
    </div>
  )
}

export function SpinnerView({ node }: Props): JSX.Element {
  const label = String(node.props.label ?? '')
  return (
    <span className="inline-flex items-center gap-2 text-meta text-[color:var(--text-muted)]">
      <Spinner label={label} />
      {node.props.labelHidden ? null : <span aria-hidden="true">{label}</span>}
    </span>
  )
}

export function ProgressView({ node }: Props): JSX.Element {
  const label = String(node.props.label ?? '')
  const value = typeof node.props.value === 'number' ? node.props.value : null
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(value === null ? {} : { 'aria-valuenow': value })}
      className="flex flex-col gap-1"
    >
      {node.props.labelHidden ? null : (
        <span aria-hidden="true" className="text-meta text-[color:var(--text-muted)]">
          {label}
        </span>
      )}
      <Meter value={value} />
    </div>
  )
}

export function EmptyStateView({ node, path }: Props): JSX.Element {
  const view = useComponents()
  return (
    <EmptyState
      density="list"
      title={String(node.props.title ?? '')}
      {...(typeof node.props.description === 'string' ? { body: node.props.description } : {})}
      {...(typeof node.props.icon === 'string' ? { glyph: <ComponentIcon name={node.props.icon} /> } : {})}
      {...(node.children.length > 0 ? { action: view.renderChildren(node.children, path) } : {})}
    />
  )
}

/** A time Studio keeps current as it passes, so the panel never polls. */
export function RelativeTimeText({
  at,
  format,
  locale,
}: {
  at: number
  format: RelativeTimeFormat
  locale: string
}): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const valid = Number.isFinite(new Date(at).getTime())
  useEffect(() => {
    if (!valid) return
    const timer = setTimeout(() => setNow(Date.now()), relativeTimeTickMs(at - now))
    return () => clearTimeout(timer)
  }, [at, now, valid])
  // A time outside the dates a clock can show (`at: 1e100`) has no words: a dash.
  if (!valid) return <span data-relative-time-invalid="">—</span>
  return (
    <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString(locale)}>
      {formatRelativeTime(at, now, format, locale)}
    </time>
  )
}

export function RelativeTimeView({ node }: Props): JSX.Element {
  const view = useComponents()
  const ink = toneInk(node.props.tone) ?? (node.props.muted ? 'var(--text-muted)' : undefined)
  return (
    <span style={ink ? { color: ink } : undefined}>
      <RelativeTimeText
        at={Number(node.props.at)}
        format={(node.props.format as RelativeTimeFormat | undefined) ?? 'short'}
        locale={view.locale}
      />
    </span>
  )
}

export function UnsupportedView({ name }: { name: string }): JSX.Element {
  return (
    <div
      data-component-placeholder={name}
      className="rounded-sm border border-dashed border-[color:var(--border-default)] px-2 py-1 text-meta text-[color:var(--text-muted)]"
    >
      {`${name} is not available in this Studio.`}
    </div>
  )
}
