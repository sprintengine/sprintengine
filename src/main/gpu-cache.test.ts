import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { clearStaleGpuCaches, GPU_CACHE_MARKER } from './gpu-cache'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function profile(): string {
  const root = mkdtempSync(join(tmpdir(), 'gpu-cache-'))
  roots.push(root)
  for (const name of ['GPUCache', 'GrShaderCache', 'Local Storage']) {
    mkdirSync(join(root, name))
    writeFileSync(join(root, name, 'data'), 'x')
  }
  return root
}

test('a first launch, or a launch on another Electron, clears the GPU caches and nothing else', () => {
  const root = profile()
  clearStaleGpuCaches(root, '39.2.0')
  assert.equal(existsSync(join(root, 'GPUCache')), false)
  assert.equal(existsSync(join(root, 'GrShaderCache')), false)
  assert.equal(existsSync(join(root, 'Local Storage', 'data')), true)
  assert.equal(readFileSync(join(root, GPU_CACHE_MARKER), 'utf8'), '39.2.0')

  mkdirSync(join(root, 'GPUCache'))
  clearStaleGpuCaches(root, '39.2.1')
  assert.equal(existsSync(join(root, 'GPUCache')), false)
  assert.equal(readFileSync(join(root, GPU_CACHE_MARKER), 'utf8'), '39.2.1')
})

test('a launch on the same Electron keeps the caches Chromium built', () => {
  const root = profile()
  writeFileSync(join(root, GPU_CACHE_MARKER), '39.2.0\n')
  clearStaleGpuCaches(root, '39.2.0')
  assert.equal(existsSync(join(root, 'GPUCache', 'data')), true)
})

test('a profile that cannot be written to does not stop the launch', () => {
  const root = profile()
  // The marker's path is a directory, so reading it fails with something other than ENOENT.
  mkdirSync(join(root, GPU_CACHE_MARKER))
  assert.doesNotThrow(() => clearStaleGpuCaches(root, '39.2.0'))
  assert.equal(existsSync(join(root, 'GPUCache', 'data')), true)
})
