// A Table and a Tree. The panel holds the sort and the selection: Studio
// draws the column a click asked to sort by and reports it (`onSortChange`),
// and the panel hands the rows over in that order. The Tree opens and closes
// on its own (`defaultExpanded`) and reports the item picked (`onSelect`).

import {
  atom,
  read,
  set,
  Heading,
  Stack,
  Table,
  Text,
  Tree,
  type TableRow,
  type TableSort,
  type TreeItem,
} from '@sprintengine/extension-sdk/components'

type SampleFile = { path: string; kind: string; size: number; changedMinutesAgo: number }

const FILES: SampleFile[] = [
  { path: 'src/panel.tsx', kind: 'TypeScript', size: 4120, changedMinutesAgo: 4 },
  { path: 'src/list.ts', kind: 'TypeScript', size: 1830, changedMinutesAgo: 95 },
  { path: 'src/icons/add.png', kind: 'Image', size: 912, changedMinutesAgo: 60 * 26 },
  { path: 'test/panel.test.tsx', kind: 'TypeScript', size: 2675, changedMinutesAgo: 30 },
  { path: 'extension.json', kind: 'JSON', size: 540, changedMinutesAgo: 60 * 24 * 6 },
  { path: 'README.md', kind: 'Markdown', size: 1210, changedMinutesAgo: 60 * 3 },
]

const TREE: TreeItem[] = [
  {
    key: 'src',
    label: 'src',
    icon: 'folder',
    children: [
      { key: 'src/panel.tsx', label: 'panel.tsx', icon: 'file' },
      { key: 'src/list.ts', label: 'list.ts', icon: 'file' },
      { key: 'src/icons', label: 'icons', icon: 'folder', children: [{ key: 'src/icons/add.png', label: 'add.png' }] },
    ],
  },
  { key: 'test', label: 'test', icon: 'folder', children: [{ key: 'test/panel.test.tsx', label: 'panel.test.tsx' }] },
  { key: 'extension.json', label: 'extension.json', icon: 'file' },
  { key: 'README.md', label: 'README.md', icon: 'file' },
]

const sort = atom<TableSort>('files.sort', { column: 'path', direction: 'asc' })
const selected = atom<string[]>('files.selected', [])
const picked = atom<string | undefined>('files.picked', undefined)

// One clock for the module, so the rows stay the same from one render to the next.
const loadedAt = Date.now()

function sortedRows(by: TableSort): TableRow[] {
  const key = (file: SampleFile): string | number =>
    by.column === 'size' ? file.size : by.column === 'changed' ? -file.changedMinutesAgo : file.path
  const rows = [...FILES].sort((a, b) => {
    const [x, y] = [key(a), key(b)]
    const order = x < y ? -1 : x > y ? 1 : 0
    return by.direction === 'asc' ? order : -order
  })
  return rows.map((file) => ({
    key: file.path,
    cells: {
      path: file.path,
      kind: file.kind,
      size: `${(file.size / 1024).toFixed(1)} KB`,
      changed: { type: 'relative', at: loadedAt - file.changedMinutesAgo * 60_000, format: 'short' },
    },
  }))
}

export default function Files() {
  const by = read(sort)
  const chosen = read(selected)
  const item = read(picked)
  return (
    <Stack gap="md">
      <Heading level={2}>Files</Heading>
      <Table
        label="Files"
        columns={[
          { key: 'path', label: 'Path', sortable: true },
          { key: 'kind', label: 'Kind', width: 'sm', hideBelow: 'md' },
          { key: 'size', label: 'Size', align: 'end', width: 'xs', sortable: true },
          { key: 'changed', label: 'Changed', align: 'end', width: 'sm', sortable: true },
        ]}
        rows={sortedRows(by)}
        sort={by}
        onSortChange={(next) => set(sort, next)}
        selectionMode="multiple"
        selected={chosen}
        onSelectionChange={({ keys }) => set(selected, keys)}
        maxHeight="md"
      />
      <Text muted size="sm">
        {chosen.length === 0 ? 'No files selected' : `${chosen.length} selected`}
      </Text>
      <Tree
        label="Folders"
        items={TREE}
        defaultExpanded={['src']}
        selected={item}
        onSelect={({ key }) => set(picked, key)}
        maxHeight="md"
      />
      <Text muted size="sm">
        {item === undefined ? 'Pick a file in the tree' : `Picked ${item}`}
      </Text>
    </Stack>
  )
}
