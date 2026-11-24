import { expect, test } from 'vitest'

import {
  EXTENSION_COMMAND_ACTIONS,
  EXTENSION_REPLACEABLE_ACTIONS,
} from '../../../../packages/extension-sdk/src/extension-manifest'
import { COMMAND_REGISTRY } from '../commands/commandRegistry'

// A declarative command's `action` runs one of Studio's own commands by id, so
// every action extension.json may name must be a command the window has.
test('every command action an extension may name is a command in the registry', () => {
  const ids = new Set(COMMAND_REGISTRY.map((command) => command.id))
  expect(EXTENSION_COMMAND_ACTIONS.filter((action) => !ids.has(action))).toEqual([])
})

// A worker command's `replaces` takes over one of Studio's commands where the
// person fires it, and the install review names that command by its title.
test('every action an extension may replace is a command in the registry', () => {
  const ids = new Set(COMMAND_REGISTRY.map((command) => command.id))
  expect(EXTENSION_REPLACEABLE_ACTIONS.filter((action) => !ids.has(action))).toEqual([])
})
