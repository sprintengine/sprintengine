import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test, vi } from 'vitest'

// Two processes meet the same malformed id file. The other one moves it aside
// and mints first, so the file this one then moves aside is the other's new
// id: this one puts it back and goes by it, rather than minting a second.

const WINNER = '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d'
let raced = false

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      if (!raced && from.endsWith('studio-environment.json')) {
        raced = true
        fs.renameSync(from, `${from}.malformed-other`)
        fs.writeFileSync(from, JSON.stringify({ id: WINNER }))
      }
      fs.renameSync(from, to)
    },
  }
})

const { STUDIO_ENVIRONMENT_FILENAME, readStudioEnvironmentId } = await import('./environment-id')

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test('a malformed file another process already replaced is not moved aside twice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-environment-malformed-race-'))
  directories.push(dir)
  writeFileSync(join(dir, STUDIO_ENVIRONMENT_FILENAME), 'not json')
  assert.equal(readStudioEnvironmentId(dir), WINNER)
  assert.equal(JSON.parse(readFileSync(join(dir, STUDIO_ENVIRONMENT_FILENAME), 'utf8')).id, WINNER)
  // Only the other process's aside copy of the malformed file is left beside it.
  assert.deepEqual(readdirSync(dir).sort(), [
    STUDIO_ENVIRONMENT_FILENAME,
    `${STUDIO_ENVIRONMENT_FILENAME}.malformed-other`,
  ])
})
