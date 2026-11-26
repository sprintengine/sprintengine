import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { seedRegistry } from '../../../tests/studio-database'
import { readRegistryRoots } from './removal-sources'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'se-removal-sources-'))
  dirs.push(dir)
  return dir
}

test('the folders come from the chat records in the database, and the registry file builds before it left', () => {
  const dir = profile()
  seedRegistry(dir, {
    version: 1,
    workspaces: [
      { id: 'ws-1', folderPath: '/Users/dev/app' },
      { id: 'ws-2', folderPath: '/Users/dev/site' },
      { id: 'ws-3', folderPath: null },
    ],
  })
  writeFileSync(join(dir, 'workspace-registry.json'), '{ torn')
  assert.deepEqual(readRegistryRoots(dir), ['/Users/dev/app', '/Users/dev/site'])
})

test('a profile with neither has no folders', () => {
  assert.deepEqual(readRegistryRoots(profile()), [])
})
