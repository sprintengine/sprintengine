import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test, vi } from 'vitest'

import { createNodeStudioPlatform, installStudioPlatform, resetStudioPlatform } from '../server/platform/platform'
import { writeDiagnosticLog } from './diagnostics-service'

const dirs: string[] = []
afterEach(async () => {
  resetStudioPlatform()
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function platformLoggingTo(logsDir: string): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), 'diagnostics-data-'))
  dirs.push(dataDir)
  installStudioPlatform(createNodeStudioPlatform({ dataDir, logsDir, packaged: false, version: '0.0.0-test' }))
}

test('an entry is appended to the day’s log in the platform’s logs folder', async () => {
  const logsDir = await mkdtemp(join(tmpdir(), 'diagnostics-logs-'))
  dirs.push(logsDir)
  await platformLoggingTo(logsDir)
  const entry = await writeDiagnosticLog({ level: 'info', source: 'workspace', title: 'Test', message: 'hello' })
  assert.ok(entry.logPath.startsWith(logsDir))
  assert.match(await readFile(entry.logPath, 'utf8'), /"message":"hello"/)
})

test('a logs folder that cannot be written never rejects, and is said once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diagnostics-blocked-'))
  dirs.push(root)
  // A file where the folder should be: neither mkdir nor the append can succeed.
  const blocked = join(root, 'logs')
  await writeFile(blocked, 'not a folder')
  await platformLoggingTo(blocked)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  for (let index = 0; index < 3; index += 1) {
    const entry = await writeDiagnosticLog({ level: 'warning', source: 'workspace', title: 'Test', message: 'lost' })
    assert.equal(entry.message, 'lost')
  }
  assert.equal(warn.mock.calls.length, 1)
})
