import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { ensureExtensionFolders, MODULE_FOLDER_README } from './extension-folders'

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'sprintengine-ext-folders-'))
}

test('creates the extensions folder and seeds its README', () => {
  const base = tmpRoot()
  try {
    const moduleRoot = join(base, 'modules')
    const result = ensureExtensionFolders({ moduleRoot })

    assert.equal(result.errors.length, 0)
    assert.equal(result.moduleRoot, moduleRoot)
    assert.equal(readFileSync(join(moduleRoot, 'README.md'), 'utf8'), MODULE_FOLDER_README)
    assert.match(MODULE_FOLDER_README, /skills, MCP servers and model providers/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('is idempotent and never overwrites an edited README', () => {
  const base = tmpRoot()
  try {
    const moduleRoot = join(base, 'modules')
    ensureExtensionFolders({ moduleRoot })

    writeFileSync(join(moduleRoot, 'README.md'), 'user edited', 'utf8')
    const second = ensureExtensionFolders({ moduleRoot })

    assert.equal(second.errors.length, 0)
    assert.equal(readFileSync(join(moduleRoot, 'README.md'), 'utf8'), 'user edited')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('leaves an already-installed extension folder untouched', () => {
  const base = tmpRoot()
  try {
    const moduleRoot = join(base, 'modules')
    const installed = join(moduleRoot, 'local.weather-deck')
    mkdirSync(installed, { recursive: true })
    writeFileSync(join(installed, 'extension.json'), '{}', 'utf8')
    ensureExtensionFolders({ moduleRoot })

    assert.equal(readFileSync(join(installed, 'extension.json'), 'utf8'), '{}')
    assert.equal(existsSync(join(moduleRoot, 'README.md')), true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
