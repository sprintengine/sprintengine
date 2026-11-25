// A counter kept across restarts: a `plugin` atom is stored by Studio for the
// extension, the same in every workspace, and read back before the first
// render of the next run.

import { atom, read, set, update, Button, Heading, Row, Stack, Text } from '@sprintengine/extension-sdk/components'

const count = atom('counter.count', 0, { persist: 'plugin' })

export default function Counter() {
  const value = read(count)
  return (
    <Stack gap="md">
      <Heading level={2}>Counter</Heading>
      <Text size="md" weight="semibold">
        {value} {value === 1 ? 'press' : 'presses'}
      </Text>
      <Row gap="sm">
        <Button variant="solid" tone="accent" icon="add" onPress={() => update(count, (n) => n + 1)}>
          Add one
        </Button>
        <Button variant="outline" disabled={value === 0} onPress={() => update(count, (n) => Math.max(0, n - 1))}>
          Take one
        </Button>
        <Button variant="ghost" disabled={value === 0} onPress={() => set(count, 0)}>
          Reset
        </Button>
      </Row>
      <Text muted size="sm">
        Kept across restarts, the same in every workspace.
      </Text>
    </Stack>
  )
}
