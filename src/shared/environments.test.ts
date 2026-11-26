import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  environmentOnThisComputer,
  environmentRouteOf,
  orderEnvironmentsForPicking,
  type EnvironmentEntry,
} from './environments'

const entry = (displayName: string, route: EnvironmentEntry['routes'][number]) => ({ displayName, routes: [route] })

test('a picker lists this computer and its distributions first, then every other machine by name, whatever its route', () => {
  const listed = orderEnvironmentsForPicking([
    entry('studio', { kind: 'tailnet', connection: 'c-1' }),
    entry('This PC (Windows)', { kind: 'local' }),
    entry('build-box', { kind: 'ssh', machine: 'ssh-1' }),
    entry('WSL: Ubuntu', { kind: 'wsl', distro: 'Ubuntu' }),
    entry('Air', { kind: 'tailnet', connection: 'c-2' }),
  ])
  assert.deepEqual(
    listed.map((environment) => environment.displayName),
    ['This PC (Windows)', 'WSL: Ubuntu', 'Air', 'build-box', 'studio'],
  )
})

test('this computer holds itself and its WSL distributions; a machine is named by its best route', () => {
  assert.equal(environmentOnThisComputer(entry('x', { kind: 'local' })), true)
  assert.equal(environmentOnThisComputer(entry('x', { kind: 'wsl', distro: 'Ubuntu' })), true)
  assert.equal(environmentOnThisComputer(entry('x', { kind: 'ssh', machine: 'ssh-1' })), false)
  assert.equal(environmentOnThisComputer(entry('x', { kind: 'tailnet', connection: 'c-1' })), false)
  assert.equal(environmentRouteOf(entry('x', { kind: 'wsl', distro: 'Ubuntu' })), 'wsl:Ubuntu')
  assert.equal(environmentRouteOf(entry('x', { kind: 'ssh', machine: 'ssh-1' })), 'ssh:ssh-1')
})
