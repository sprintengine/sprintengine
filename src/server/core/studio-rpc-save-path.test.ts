import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'vitest'

import { pathInFolder } from './studio-rpc'

// A save hook reads a file's path inside the workspace it was opened in, as
// the reference app hands it: relative, with `/` between its parts, and only
// when the file is inside the workspace's folder.
test('a saved file’s path inside its workspace is relative, and absent outside it', () => {
  const folder = join('/Users/dev', 'app')
  assert.equal(pathInFolder(folder, join(folder, 'src', 'main.ts')), 'src/main.ts')
  assert.equal(pathInFolder(folder, join('/Users/dev', 'other', 'main.ts')), null)
  assert.equal(pathInFolder(folder, folder), null)
  assert.equal(pathInFolder(null, join(folder, 'main.ts')), null)
})
