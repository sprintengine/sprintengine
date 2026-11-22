import assert from 'node:assert/strict'

import type { AppSettings } from '../../../../shared/workspace'
import { defaultAppSettings } from './settingsSlice'
import {
  createKnowledgeSlice,
  isAbsolutePath,
  normalizeKnowledgeRelativeRoot,
  normalizeProjectKnowledgeRoots,
} from './knowledgeSlice'
import { test } from 'vitest'

test('a knowledge folder is a relative path inside the project', () => {
  assert.equal(normalizeKnowledgeRelativeRoot(' knowledge '), 'knowledge')
  assert.equal(normalizeKnowledgeRelativeRoot('docs/'), 'docs')
  assert.equal(normalizeKnowledgeRelativeRoot('docs\\sub'), 'docs/sub')
  assert.equal(normalizeKnowledgeRelativeRoot('.'), null)
  assert.equal(normalizeKnowledgeRelativeRoot(''), null)
  assert.equal(normalizeKnowledgeRelativeRoot('/absolute'), null)
  assert.equal(normalizeKnowledgeRelativeRoot('C:\\Users'), null)
  assert.equal(normalizeKnowledgeRelativeRoot(null), null)

  assert.equal(isAbsolutePath('/etc'), true)
  assert.equal(isAbsolutePath('C:/Users'), true)
  assert.equal(isAbsolutePath('\\\\server\\share'), true)
  assert.equal(isAbsolutePath('relative/path'), false)
})

test('stored roots keep only a project and a relative folder', () => {
  const roots = normalizeProjectKnowledgeRoots({
    '/Users/example/project/': ' docs/knowledge ',
    '/Users/example/bad': '/absolute',
    '': 'should-skip',
  })
  assert.deepEqual(roots, { '/Users/example/project': 'docs/knowledge' })
  assert.deepEqual(normalizeProjectKnowledgeRoots(undefined), {})
})

test('setting a project’s knowledge folder adds it, and null takes it away', () => {
  const carrier: { appSettings: AppSettings } = { appSettings: defaultAppSettings() }
  const slice = createKnowledgeSlice((mutator) => mutator(carrier))

  slice.setProjectKnowledgeRoot('/Users/example/project/', ' docs ')
  slice.setProjectKnowledgeRoot('/Users/example/other', 'notes')
  assert.deepEqual(carrier.appSettings.projectKnowledgeRoots, {
    '/Users/example/project': 'docs',
    '/Users/example/other': 'notes',
  })

  slice.setProjectKnowledgeRoot('/Users/example/project', null)
  assert.deepEqual(carrier.appSettings.projectKnowledgeRoots, { '/Users/example/other': 'notes' })
})
