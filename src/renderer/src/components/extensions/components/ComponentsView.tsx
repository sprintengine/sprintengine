// The window's drawing of a components panel: the tree the panel's hidden
// module rendered, checked against the catalogue (packages/extension-sdk/src/
// components/tree.ts), drawn with Studio's own controls. React's keyed
// reconciliation is the diff: each node keeps its key (the panel's, else its
// slot), so a reordered keyed list keeps each control, and what the person
// typed in it, where it is.
//
// A press or an edit goes back to the panel as a handler call; the host
// (ComponentsPanelHost) names the revision it was made on. A press on a
// control that stood still grants the panel one gesture (componentGestures.ts).
// While `inert` (the last good tree kept after a save that failed to load)
// nothing answers.

import { useLayoutEffect, useMemo, useRef, type JSX, type ReactNode } from 'react'

import type { ComponentChild, ComponentNode } from '../../../../../../packages/extension-sdk/src/components/tree'
import {
  COMPONENT_SETTLE_MS,
  createComponentGestureGeometry,
  createComponentGestureStability,
  type ComponentGestures,
} from './componentGestures'
import {
  BadgeView,
  CalloutView,
  CodeView_,
  CodeViewView,
  EmptyStateView,
  HeadingView,
  ImageView,
  KeyValueView,
  LinkView,
  MarkdownView,
  ProgressView,
  RelativeTimeView,
  SkeletonView,
  SpinnerView,
  TextView,
  UnsupportedView,
} from './componentsContent'
import { ColumnContext, ComponentsContext, GesturesProvider, type ComponentsContextValue } from './componentsContext'
import {
  ButtonView,
  CheckboxView,
  IconButtonView,
  InputView,
  ListItemView,
  ListView,
  RadioGroupView,
  SelectView,
  SliderView,
  SwitchView,
  TextareaView,
} from './componentsControls'
import {
  BoxView,
  CardView,
  CollapsibleView,
  FieldView,
  GridView,
  RowView,
  SeparatorView,
  StackView,
  TabsView,
  ToolbarView,
} from './componentsLayout'
import { TableView } from './componentsTable'
import { TreeView } from './componentsTree'
import type { ComponentsViewProps } from './componentsViewTypes'

type NodeView = (props: { node: ComponentNode; path: string }) => JSX.Element

const VIEWS: Record<string, NodeView> = {
  Stack: StackView,
  Row: RowView,
  Text: TextView,
  Heading: HeadingView,
  Button: ButtonView,
  IconButton: IconButtonView,
  Badge: BadgeView,
  Card: CardView,
  List: ListView,
  ListItem: ListItemView,
  Input: InputView,
  Switch: SwitchView,
  Select: SelectView,
  Separator: SeparatorView,
  Progress: ProgressView,
  Spinner: SpinnerView,
  EmptyState: EmptyStateView,
  Link: LinkView,
  Code: CodeView_,
  Textarea: TextareaView,
  Checkbox: CheckboxView,
  RadioGroup: RadioGroupView,
  Slider: SliderView,
  Field: FieldView,
  Tabs: TabsView,
  Collapsible: CollapsibleView,
  Toolbar: ToolbarView,
  Grid: GridView,
  Table: TableView,
  Tree: TreeView,
  Markdown: MarkdownView,
  CodeView: CodeViewView,
  Image: ImageView,
  KeyValue: KeyValueView,
  Callout: CalloutView,
  Skeleton: SkeletonView,
  RelativeTime: RelativeTimeView,
  Box: BoxView,
}

/** One node, by its type; a Tab outside its Tabs, or a component this Studio does not draw, is a placeholder. */
function NodeView({
  node,
  path,
}: {
  node: ComponentNode | Extract<ComponentChild, { type: 'Unsupported' }>
  path: string
}) {
  if (node.type === 'Unsupported') return <UnsupportedView name={String(node.props.name)} />
  const View = VIEWS[node.type]
  if (!View) return <UnsupportedView name={node.type} />
  return <View node={node} path={path} />
}

function renderChildren(children: ComponentChild[], path: string): ReactNode {
  return children.map((child, index) => {
    if (typeof child === 'string') return child
    const key = child.key ?? `#${index}`
    return <NodeView key={key} node={child} path={`${path}/${key}`} />
  })
}

export function ComponentsView({
  tree,
  revision,
  dispatch,
  grantGesture,
  openLink,
  readImage,
  inert,
  locale,
  run = '',
}: ComponentsViewProps): JSX.Element {
  const container = useRef<HTMLDivElement | null>(null)
  const gestures = useMemo<ComponentGestures>(() => {
    const clock = () => performance.now()
    return { clock, stability: createComponentGestureStability(), geometry: createComponentGestureGeometry(clock) }
  }, [])

  // Every accepted tree is observed when it is drawn: a changed control starts its wait again.
  useLayoutEffect(() => {
    gestures.stability.observe(tree, gestures.clock())
  }, [tree, revision, gestures])
  // Positions are measured after every commit, and on a timer while waits run, so
  // a sibling that grew above a control is seen even when nothing else drew.
  useLayoutEffect(() => {
    gestures.geometry.setContainer(container.current)
    gestures.geometry.sample()
  })
  useLayoutEffect(() => {
    const timer = setInterval(() => gestures.geometry.sample(), COMPONENT_SETTLE_MS / 5)
    return () => clearInterval(timer)
  }, [gestures])

  const value = useMemo<ComponentsContextValue>(
    () => ({
      send: (callback, args, edit) => {
        if (inert) return
        dispatch(callback, args, edit === undefined ? undefined : { edit })
      },
      grantGesture: (stood) => {
        if (!inert) grantGesture(stood)
      },
      openLink: (href) => {
        if (!inert) openLink(href)
      },
      readImage,
      inert,
      locale,
      run,
      gestures,
      renderChildren,
    }),
    [dispatch, grantGesture, openLink, readImage, inert, locale, run, gestures],
  )

  return (
    <ComponentsContext.Provider value={value}>
      <GesturesProvider gestures={gestures}>
        <div
          ref={container}
          data-components-view=""
          data-inert={inert ? 'true' : undefined}
          inert={inert || undefined}
          className="flex min-h-0 min-w-0 flex-col gap-2 text-body text-[color:var(--text-default)]"
        >
          <ColumnContext.Provider value={true}>
            {tree ? <NodeView key={tree.key ?? '#root'} node={tree} path={`/${tree.key ?? '#root'}`} /> : null}
          </ColumnContext.Provider>
        </div>
      </GesturesProvider>
    </ComponentsContext.Provider>
  )
}
