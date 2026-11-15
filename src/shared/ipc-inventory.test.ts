import assert from 'node:assert/strict'
import { test } from 'vitest'

import { IPC_INVENTORY, ipcInventoryRow, mayRegisterIpcChannel } from './ipc-inventory'

test('a channel made per id falls under its `:*` row; an unlisted one under none', () => {
  assert.deepEqual(ipcInventoryRow('fs:watch-event:watch-1@wsl:Ubuntu'), IPC_INVENTORY['fs:watch-event:*'])
  assert.deepEqual(ipcInventoryRow('window:close'), IPC_INVENTORY['window:close'])
  assert.equal(ipcInventoryRow('fs:watch-event'), undefined)
  assert.equal(ipcInventoryRow('nobody:listed'), undefined)
})

test('only a renderer-to-main row may be registered in main', () => {
  assert.equal(mayRegisterIpcChannel('window:close'), true)
  assert.equal(mayRegisterIpcChannel('window:state-changed'), false)
  assert.equal(mayRegisterIpcChannel('nobody:listed'), false)
})

test('every shell row gives its reason, and a `:*` row is a push', () => {
  for (const [channel, row] of Object.entries(IPC_INVENTORY)) {
    if ('shell' in row) assert.ok(row.shell.length > 10, channel)
    if (channel.endsWith(':*')) assert.equal(row.dir, 'push', channel)
  }
})
