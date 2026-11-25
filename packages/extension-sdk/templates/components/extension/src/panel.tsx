// A checklist for the workspace the panel is open in. It is a components
// panel (`"ui": "components"` in extension.json): the module runs hidden and
// sandboxed, renders a tree of Studio's own components, and Studio draws them
// with its own controls, in light and dark, with its keyboard and focus rules.
// There is no HTML and no CSS here, and nothing to build: Studio compiles this
// file's JSX for `@sprintengine/extension-sdk/components`, which it provides.
//
// State lives in atoms. Reading one while rendering draws the panel again
// whenever it changes; `set` and `update` change one from an event handler.

import {
  atom,
  read,
  set,
  update,
  Button,
  Checkbox,
  EmptyState,
  IconButton,
  Input,
  List,
  ListItem,
  Row,
  Stack,
  Text,
} from '@sprintengine/extension-sdk/components'

export type Item = { id: string; text: string; done: boolean }

// Kept for each workspace across restarts. If `Item` changes shape, raise
// `version` and add `migrate` to turn what an older version stored into it.
const items = atom<Item[]>('items', [], { persist: 'workspace' })

// What is typed and not yet added. Kept in memory only, but keyed, so a save
// in a development folder hands it to the reloaded panel: half-typed text
// survives the reload.
const draft = atom('draft', '')

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function add(text: string): void {
  const trimmed = text.trim()
  if (!trimmed) return
  update(items, (list) => [...list, { id: newId(), text: trimmed, done: false }])
  set(draft, '')
}

function tick(id: string, done: boolean): void {
  update(items, (list) => list.map((item) => (item.id === id ? { ...item, done } : item)))
}

function remove(id: string): void {
  update(items, (list) => list.filter((item) => item.id !== id))
}

export default function Checklist() {
  const list = read(items)
  const left = list.filter((item) => !item.done).length
  return (
    <Stack gap="md">
      <Row gap="sm" align="end">
        <Input
          label="New item"
          labelHidden
          placeholder="Add an item"
          value={read(draft)}
          onChange={(value) => set(draft, value)}
          onSubmit={add}
        />
        <Button icon="add" onPress={() => add(read(draft))}>
          Add
        </Button>
      </Row>
      {list.length === 0 ? (
        <EmptyState title="Nothing on the list" description="Type an item above and press Enter." icon="check" />
      ) : (
        <Stack gap="sm">
          <List label="Items">
            {list.map((item) => (
              <ListItem key={item.id}>
                <Row justify="between" align="center">
                  <Checkbox label={item.text} checked={item.done} onChange={(done) => tick(item.id, done)} />
                  <IconButton
                    icon="delete"
                    label={`Remove ${item.text}`}
                    variant="ghost"
                    onPress={() => remove(item.id)}
                  />
                </Row>
              </ListItem>
            ))}
          </List>
          <Text muted size="sm">
            {left} of {list.length} left
          </Text>
        </Stack>
      )}
    </Stack>
  )
}
