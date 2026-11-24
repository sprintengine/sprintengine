// Whether @sprintengine/extension-sdk is ready to publish, and under which npm
// dist-tag. Run by sdk-publish.yml before `npm publish`, and covered offline by
// sdk-release-check.test.mjs, which also runs it against this tree so a
// release-blocking mismatch fails `npm run test:release` on the pull request
// that introduces it rather than on the day someone tags.
//
// It checks what a reader of the package takes on trust:
//
//   - the CHANGELOG's newest entry is the version being published;
//   - docs/compatibility.md names the first Studio that reads extension.json,
//     the EXTENSION_MANIFEST_SINCE packages/extension-sdk/src/extension-manifest.ts
//     declares;
//   - a pushed `sdk-v*` tag names the package's version exactly.
//
// The parsing is pure; only checkSdkReleaseTree and the command line read files.

import { appendFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SDK_TAG_PREFIX = 'sdk-v'

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

export function isSemver(version) {
  return typeof version === 'string' && SEMVER.test(version)
}

// npm refuses a prerelease without an explicit tag, and publishing one under
// `latest` would hand it to every `npm install` of the package. A prerelease
// goes out under its first identifier (`1.0.0-beta.0` → `beta`), a release
// under `latest`.
export function distTagForVersion(version) {
  const match = SEMVER.exec(version)
  if (!match) throw new Error(`"${version}" is not a semver version.`)
  const prerelease = match[4]
  if (!prerelease) return 'latest'
  const first = prerelease.split('.')[0]
  return /^[A-Za-z][0-9A-Za-z-]*$/.test(first) ? first : 'next'
}

// The version of the first `## ` heading: `## 1.0.0-beta.0` or
// `## 0.5.0 — 2026-09-10`. Null when the file has no version heading first.
export function changelogHeadVersion(changelog) {
  const heading = changelog.split(/\r?\n/).find((line) => line.startsWith('## '))
  if (!heading) return null
  const version = heading.slice(3).trim().split(/\s/)[0]
  return isSemver(version) ? version : null
}

// `export const EXTENSION_MANIFEST_SINCE = '0.13.0'`: the first Studio that
// reads extension.json. Null when the source does not declare it as a literal.
export function manifestSinceFromSource(source) {
  const match = /export const EXTENSION_MANIFEST_SINCE\s*=\s*['"]([^'"]+)['"]/.exec(source)
  return match && isSemver(match[1]) ? match[1] : null
}

export function checkSdkRelease({ packageVersion, changelog, manifestSource, compatibility, tag }) {
  const problems = []
  if (!isSemver(packageVersion)) {
    problems.push(`packages/extension-sdk/package.json: "${packageVersion}" is not a semver version.`)
  }

  const head = changelogHeadVersion(changelog)
  if (head === null) {
    problems.push('packages/extension-sdk/CHANGELOG.md: the first "## " heading does not name a version.')
  } else if (head !== packageVersion) {
    problems.push(
      `packages/extension-sdk/CHANGELOG.md: the newest entry is ${head}, and package.json is ${packageVersion}. Write the ${packageVersion} entry first.`,
    )
  }

  const since = manifestSinceFromSource(manifestSource)
  if (since === null) {
    problems.push(
      'packages/extension-sdk/src/extension-manifest.ts: EXTENSION_MANIFEST_SINCE is not a semver string literal.',
    )
  } else if (!compatibility.includes('EXTENSION_MANIFEST_SINCE') || !compatibility.includes(since)) {
    problems.push(
      `docs/compatibility.md: does not say that extension.json is read from Studio ${since} (\`EXTENSION_MANIFEST_SINCE\`).`,
    )
  }

  if (tag !== undefined && tag !== `${SDK_TAG_PREFIX}${packageVersion}`) {
    problems.push(
      `The tag is ${tag}, and package.json is ${packageVersion}: tag ${SDK_TAG_PREFIX}${packageVersion} or change the version.`,
    )
  }

  const distTag = isSemver(packageVersion) ? distTagForVersion(packageVersion) : null
  return { ok: problems.length === 0, problems, version: packageVersion, distTag }
}

// The files the check reads, from a checkout at `root`.
export function readSdkReleaseInputs(root) {
  const sdk = join(root, 'packages', 'extension-sdk')
  const read = (...parts) => readFileSync(join(...parts), 'utf8')
  return {
    packageVersion: JSON.parse(read(sdk, 'package.json')).version,
    changelog: read(sdk, 'CHANGELOG.md'),
    manifestSource: read(sdk, 'src', 'extension-manifest.ts'),
    compatibility: read(root, 'docs', 'compatibility.md'),
  }
}

export function checkSdkReleaseTree(root, { tag } = {}) {
  return checkSdkRelease({ ...readSdkReleaseInputs(root), tag })
}

// node scripts/release/sdk-release-check.mjs [--tag <sdk-v…>]
// Prints every problem and exits 1, or prints the version and dist-tag (and
// writes both to $GITHUB_OUTPUT when set).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const tagIndex = args.indexOf('--tag')
  const tag = tagIndex === -1 ? undefined : args[tagIndex + 1] || undefined
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
  const result = checkSdkReleaseTree(root, { tag })
  if (!result.ok) {
    for (const problem of result.problems) console.error(`- ${problem}`)
    process.exit(1)
  }
  console.log(`@sprintengine/extension-sdk ${result.version} is ready to publish under the "${result.distTag}" tag.`)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${result.version}\ndist_tag=${result.distTag}\n`)
  }
}
