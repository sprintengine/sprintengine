import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import { watchTreeByFolder } from './dev-folder-watch'

// The folder-by-folder watch Linux uses for a development folder: only
// folders are watched, never a file or a link, and a folder made again (an
// editor or a checkout replacing src/) is followed in its place.

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`)
    await new Promise((settle) => setTimeout(settle, 20))
  }
}

test('only folders are watched; a folder deleted and made again keeps being followed', async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'se-dev-watch-')))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'se-dev-watch-outside-')))
  made.push(folder, outside)
  mkdirSync(join(folder, 'src'))
  writeFileSync(join(folder, 'src', 'panel.ts'), 'export {}\n')
  mkdirSync(join(folder, 'node_modules', 'x'), { recursive: true })
  symlinkSync(outside, join(folder, 'linked'))
  const heard: string[] = []
  const watch = watchTreeByFolder(
    folder,
    (name) => {
      if (name) heard.push(name)
    },
    () => undefined,
  )
  try {
    assert.deepEqual(watch.watching().sort(), [folder, join(folder, 'src')])

    rmSync(join(folder, 'src'), { recursive: true })
    await until(() => !watch.watching().includes(join(folder, 'src')), 'the gone folder to be let go')
    mkdirSync(join(folder, 'src'))
    await until(() => watch.watching().includes(join(folder, 'src')), 'the new folder to be followed')
    heard.splice(0)
    writeFileSync(join(folder, 'src', 'panel.ts'), 'export const saved = 1\n')
    await until(() => heard.includes('src/panel.ts'), 'a save in the new src/')
  } finally {
    watch.close()
  }
}, 30_000)
