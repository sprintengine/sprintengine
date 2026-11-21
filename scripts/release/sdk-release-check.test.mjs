import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  changelogHeadVersion,
  checkSdkRelease,
  checkSdkReleaseTree,
  distTagForVersion,
  manifestSinceFromSource,
} from './sdk-release-check.mjs'

const MANIFEST_SOURCE = "/** The first Studio that reads extension.json. */\nexport const EXTENSION_MANIFEST_SINCE = '0.13.0'\n"
const COMPATIBILITY = 'extension.json is read from Studio 0.13.0 (`EXTENSION_MANIFEST_SINCE`).'
const CHANGELOG = '# Changelog\n\n## 1.2.0-beta.3\n\n- Things.\n\n## 1.1.0 — 2026-09-10\n'

function inputs(overrides = {}) {
  return {
    packageVersion: '1.2.0-beta.3',
    changelog: CHANGELOG,
    manifestSource: MANIFEST_SOURCE,
    compatibility: COMPATIBILITY,
    ...overrides,
  }
}

test('a consistent tree is ready, and a prerelease goes out under its own dist-tag', () => {
  const result = checkSdkRelease(inputs())
  assert.deepEqual(result.problems, [])
  assert.equal(result.ok, true)
  assert.equal(result.distTag, 'beta')
})

test('the dist-tag is latest only for a release, never for a prerelease', () => {
  assert.equal(distTagForVersion('1.0.0'), 'latest')
  assert.equal(distTagForVersion('1.0.0-beta.0'), 'beta')
  assert.equal(distTagForVersion('1.0.0-rc.2'), 'rc')
  assert.equal(distTagForVersion('1.0.0-0'), 'next')
  assert.throws(() => distTagForVersion('v1.0.0'), /not a semver/)
})

test('the changelog head is the first version heading, with or without a date', () => {
  assert.equal(changelogHeadVersion(CHANGELOG), '1.2.0-beta.3')
  assert.equal(changelogHeadVersion('# Changelog\n\n## 0.5.0 — 2026-09-10\n'), '0.5.0')
  assert.equal(changelogHeadVersion('# Changelog\n\n## Unreleased\n\n## 0.5.0\n'), null)
})

test('a changelog whose newest entry is another version blocks the release', () => {
  const result = checkSdkRelease(inputs({ packageVersion: '1.2.0' }))
  assert.equal(result.ok, false)
  assert.match(result.problems.join('\n'), /newest entry is 1\.2\.0-beta\.3, and package\.json is 1\.2\.0/)
})

test('an Unreleased heading on top blocks the release', () => {
  const result = checkSdkRelease(inputs({ changelog: '# Changelog\n\n## Unreleased\n\n## 1.2.0-beta.3\n' }))
  assert.match(result.problems.join('\n'), /does not name a version/)
})

test('the first Studio that reads extension.json is read from the source', () => {
  assert.equal(manifestSinceFromSource(MANIFEST_SOURCE), '0.13.0')
  assert.equal(manifestSinceFromSource('export const EXTENSION_MANIFEST_SINCE = SOMETHING'), null)
  const missing = checkSdkRelease(inputs({ manifestSource: 'export const OTHER = 1\n' }))
  assert.match(missing.problems.join('\n'), /EXTENSION_MANIFEST_SINCE is not a semver string literal/)
})

test('the compatibility doc must name that Studio, and the constant', () => {
  const stale = checkSdkRelease(
    inputs({ compatibility: 'extension.json is read from Studio 0.12.0 (`EXTENSION_MANIFEST_SINCE`).' }),
  )
  assert.match(stale.problems.join('\n'), /does not say that extension\.json is read from Studio 0\.13\.0/)
  const unnamed = checkSdkRelease(inputs({ compatibility: 'extension.json is read from Studio 0.13.0.' }))
  assert.equal(unnamed.ok, false)
})

test('a pushed tag must name the package version exactly', () => {
  assert.equal(checkSdkRelease(inputs({ tag: 'sdk-v1.2.0-beta.3' })).ok, true)
  const wrong = checkSdkRelease(inputs({ tag: 'sdk-v1.2.0' }))
  assert.match(wrong.problems.join('\n'), /The tag is sdk-v1\.2\.0, and package\.json is 1\.2\.0-beta\.3/)
})

// The real tree: a mismatch fails here, on the pull request that makes it.
test('this checkout is ready to publish', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const result = checkSdkReleaseTree(root)
  assert.deepEqual(result.problems, [])
})
