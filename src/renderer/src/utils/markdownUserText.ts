// Markdown as a person typed it into the composer, rather than as a document.
//
// A message is read back as markdown so a pasted code fence, a list or a link
// renders the way it would anywhere else. Two document rules would betray
// what was typed, though: a single newline would fold two lines into one
// sentence, and an HTML-looking fragment (`<div>` in a question about a
// template) would vanish into the renderer instead of being shown. So every
// newline in prose is a line break, and HTML is text.
//
// A third rule is about numbers. A document numbers an ordered list from its
// first marker, so answering only questions 3 and 5 of an agent's list would
// read back as 3 and 4, while the agent received 3 and 5. Each item keeps the
// number that was typed in front of it.

// The slice of the markdown syntax tree this pass reads and writes. Declared
// here for the same reason the alert pass declares its own: the tree's types
// belong to a package the renderer only reaches through remark.
type UserTextNode = {
  type: string
  value?: string
  ordered?: boolean | null
  position?: { start: { offset?: number } }
  data?: { hProperties?: Record<string, unknown> }
  children?: UserTextNode[]
}

type SourceFile = { value?: unknown }

// Containers whose children are blocks: an HTML block directly inside one
// becomes a paragraph of its text, not a bare text node between blocks.
const FLOW_CONTAINERS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition'])

/** Remark plugin: hard line breaks in prose, HTML shown as the text it is, and list numbers as typed. */
export function remarkUserText() {
  return (tree: UserTextNode, file?: SourceFile) => rewrite(tree, typeof file?.value === 'string' ? file.value : '')
}

// The number written at the start of an ordered list item: `5.` or `5)`.
const TYPED_NUMBER = /^(\d{1,9})[.)]/u

function keepTypedNumbers(list: UserTextNode, source: string): void {
  for (const item of list.children ?? []) {
    const offset = item.position?.start.offset
    if (item.type !== 'listItem' || offset === undefined) continue
    const typed = TYPED_NUMBER.exec(source.slice(offset, offset + 12))
    if (!typed) continue
    item.data = { ...item.data, hProperties: { ...item.data?.hProperties, value: Number(typed[1]) } }
  }
}

function rewrite(node: UserTextNode, source: string): void {
  if (!node.children) return
  if (node.type === 'list' && node.ordered && source) keepTypedNumbers(node, source)
  const flow = FLOW_CONTAINERS.has(node.type)
  const children: UserTextNode[] = []
  for (const child of node.children) {
    if (child.type === 'html') {
      const text = breakLines(child.value ?? '')
      children.push(...(flow ? [{ type: 'paragraph', children: text }] : text))
    } else if (child.type === 'text') {
      children.push(...breakLines(child.value ?? ''))
    } else {
      rewrite(child, source)
      children.push(child)
    }
  }
  node.children = children
}

// One text node per line with a break between each, as remark's own hard
// break (two trailing spaces) would have produced.
function breakLines(value: string): UserTextNode[] {
  const lines = value.split(/\r?\n/u)
  const nodes: UserTextNode[] = []
  lines.forEach((line, index) => {
    if (index > 0) nodes.push({ type: 'break' })
    if (line) nodes.push({ type: 'text', value: line })
  })
  return nodes
}
