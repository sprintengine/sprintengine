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
  // A watch on macOS is live a moment after it is made, and later still on a
  // loaded machine: a change made before then is never heard. So each folder
  // is touched (a dotfile, which is not a module) until its watch answers, and
  // only then is the change under test made, counted from there.
  const armed = async (dir: string): Promise<number> => {
    const before = changes
    for (let probe = 0; changes === before; probe += 1) {
      if (probe > 150) throw new Error(`the watch on ${dir} never answered`)
      writeFileSync(join(dir, '.probe'), String(probe))
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    // Let the probes' own quiet pass, so none lands in the count below.
    await new Promise((resolve) => setTimeout(resolve, 150))
    return changes
  }
  try {
    const beforeDrop = await armed(root)
    mkdirSync(join(root, 'dropped'))
    await until(() => changes === beforeDrop + 1)
    const beforeManifest = await armed(join(root, 'dropped'))
    writeFileSync(join(root, 'dropped', 'manifest.json'), '{}')
    await until(() => changes === beforeManifest + 1)
  } finally {
    stop()
    rmSync(join(root, '..'), { recursive: true, force: true })
  }
})
