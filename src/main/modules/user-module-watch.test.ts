import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { watchUserModuleRoot } from './user-module-watch'

const until = async (check: () => boolean, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('a module dropped in, and its manifest written after its folder, each tell the windows once', async () => {
  const root = join(mkdtempSync(join(tmpdir(), 'module-watch-')), 'modules')
  let changes = 0
  const stop = watchUserModuleRoot(root, () => (changes += 1), 50)
  try {
    mkdirSync(join(root, 'dropped'))
    await until(() => changes === 1)
    writeFileSync(join(root, 'dropped', 'manifest.json'), '{}')
    await until(() => changes === 2)
  } finally {
    stop()
    rmSync(join(root, '..'), { recursive: true, force: true })
  }
})
