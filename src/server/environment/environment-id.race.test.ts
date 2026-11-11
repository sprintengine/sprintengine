import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test, vi } from 'vitest'

// Another process (the desktop and its server, starting for the first time
// together) mints between this one's read and its create: the link that would
// put this one's id in place finds the file there, and this one goes by the
// winner's id.

const WINNER = '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d'

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    linkSync: (from: string, to: string) => {
      fs.writeFileSync(to, JSON.stringify({ id: WINNER }))
      fs.linkSync(from, to)
    },
  }
})

const { STUDIO_ENVIRONMENT_FILENAME, readStudioEnvironmentId } = await import('./environment-id')

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test('a process that loses the race to mint goes by the winner’s id, and leaves the winner’s file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-environment-race-'))
  directories.push(dir)
  assert.equal(readStudioEnvironmentId(dir), WINNER)
  assert.deepEqual(readdirSync(dir), [STUDIO_ENVIRONMENT_FILENAME])
})
