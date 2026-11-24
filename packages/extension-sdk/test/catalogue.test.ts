// The catalogue format: strict validation (what a catalogue's own checks
// run), tolerant reading (what Studio runs on a catalogue it fetched), the
// kill list, release entries against manifests, publishers from git URLs, and
// `sprintengine-extension release-entry` over a local git repository.

import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildSync } from 'esbuild'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import {
  catalogueContributions,
  catalogueReleaseEntry,
  catalogueReleaseMismatch,
  findKilled,
  gitUrlPublisher,
  isAllowedGitUrl,
  isReservedInstallKey,
  isSameCatalogueSource,
  readCatalogue,
  readKillList,
  readReleaseLock,
  selectCatalogueRelease,
  validateCatalogue,
  type CatalogueRelease,
} from '../src/catalogue.js'
import {
  EXTENSION_MANIFEST_SINCE,
  validateExtensionManifest,
  type ExtensionManifest,
} from '../src/extension-manifest.js'
import { fetchGitCommit, materializeGitTree, runGit } from '../src/git-source.js'
import { computeModuleFileDigestsSync } from '../src/module-files.js'
import { extensionContentFingerprint } from '../src/signing.js'

const COMMIT = 'a'.repeat(40)
const HASH = 'b'.repeat(64)

const release = (over: Partial<CatalogueRelease> = {}): CatalogueRelease => ({
  version: '1.0.0',
  commit: COMMIT,
  contentHash: HASH,
  tier: 'declarative',
  minimumStudio: EXTENSION_MANIFEST_SINCE,
  permissions: [],
  contributes: [{ kind: 'skills', name: 'notes' }],
  ...over,
})

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'acme.notes',
  source: { url: 'https://github.com/acme/notes.git', ref: 'main' },
  releases: [release()],
  ...over,
})

const catalogue = (extensions: unknown[], over: Record<string, unknown> = {}) => ({
  catalogueVersion: 1,
  name: 'Community extensions',
  owner: 'sprintengine',
  extensions,
  ...over,
})

function manifest(over: Record<string, unknown> = {}): ExtensionManifest {
  const result = validateExtensionManifest({
    manifestVersion: 1,
    id: 'notes',
    version: '1.0.0',
    engines: { studio: `>=${EXTENSION_MANIFEST_SINCE}` },
    tier: 'declarative',
    name: 'Notes',
    contributes: { skills: [{ id: 'notes', path: 'skills/notes' }] },
    ...over,
  })
  if (!result.ok) throw new Error(JSON.stringify(result.issues))
  return result.manifest
}

describe('validation is strict', () => {
  test('a well-formed catalogue validates', () => {
    const result = validateCatalogue(catalogue([entry({ categories: ['productivity'], ownerId: 42 })]))
    expect(result.ok).toBe(true)
  })

  test('every problem is an issue: unknown keys, a bad commit, a repeated id, a non-git URL', () => {
    const result = validateCatalogue(
      catalogue([
        entry({ surprise: true }),
        entry({ releases: [release({ commit: 'HEAD' })] }),
        entry({ id: 'acme.other', source: { url: 'http://example.com/x.git', ref: 'main' } }),
        entry({ id: 'acme.other' }),
      ]),
    )
    expect(result.ok).toBe(false)
    const paths = result.ok ? [] : result.issues.map((issue) => issue.path)
    expect(paths).toContain('extensions[0].surprise')
    expect(paths).toContain('extensions[1].releases[0].commit')
    if (!result.ok) return
  })

  test('a repeated id and an unfetchable URL are cross-field issues', () => {
    const result = validateCatalogue(
      catalogue([
        entry(),
        entry(),
        entry({ id: 'acme.web', source: { url: 'http://example.com/x.git', ref: 'main' } }),
      ]),
    )
    expect(result.ok).toBe(false)
    const messages = result.ok ? [] : result.issues.map((issue) => `${issue.path} ${issue.message}`)
    expect(messages.some((line) => line.startsWith('extensions[1].id lists acme.notes again'))).toBe(true)
    expect(messages.some((line) => line.startsWith('extensions[2].source.url'))).toBe(true)
  })

  test('an id must be <publisher>.<id>', () => {
    const result = validateCatalogue(catalogue([entry({ id: 'notes' })]))
    expect(result.ok).toBe(false)
  })
})

describe('reading is tolerant', () => {
  test('unknown keys are ignored, and an entry or release that does not read is skipped', () => {
    const read = readCatalogue(
      catalogue([
        entry({ futureField: { nested: true }, releases: [{ ...release(), shiny: 1 }, { version: 'nope' }] }),
        { id: 'broken' },
        entry({ id: 'acme.second', releases: [{ version: '2.0.0' }] }),
        entry({ id: 'acme.third', description: 42, categories: ['ok', 'NOT OK', 'ok'] }),
      ]),
    )
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.catalogue.extensions.map((item) => item.id)).toEqual(['acme.notes', 'acme.third'])
    expect(read.catalogue.extensions[0]!.releases).toHaveLength(1)
    expect('shiny' in read.catalogue.extensions[0]!.releases[0]!).toBe(false)
    // An invalid display field is dropped; a list keeps what reads, once each.
    expect(read.catalogue.extensions[1]!.description).toBeUndefined()
    expect(read.catalogue.extensions[1]!.categories).toEqual(['ok'])
  })

  test('a repeated id keeps the first entry', () => {
    const read = readCatalogue(catalogue([entry({ description: 'first' }), entry({ description: 'second' })]))
    expect(read.ok && read.catalogue.extensions.map((item) => item.description)).toEqual(['first'])
  })

  test('a newer format is refused with the fix, not misread', () => {
    const read = readCatalogue(catalogue([entry()], { catalogueVersion: 2 }))
    expect(read).toEqual({
      ok: false,
      message: 'The catalogue uses catalogue format 2; update Studio to browse this catalogue.',
    })
  })

  test('the newest release this Studio meets is offered, else the least newer one', () => {
    const releases = [release({ version: '3.0.0', minimumStudio: '99.0.0' }), release({ version: '2.0.0' })]
    expect(selectCatalogueRelease(releases)).toEqual({ release: releases[1], installable: true })
    const none = [release({ version: '3.0.0', minimumStudio: '99.0.0' }), release({ minimumStudio: '50.0.0' })]
    expect(selectCatalogueRelease(none)).toEqual({ release: none[1], installable: false })
  })

  test('the release lock keeps the first record of a version', () => {
    const lock = readReleaseLock({
      lockVersion: 1,
      releases: [
        { id: 'acme.notes', version: '1.0.0', commit: COMMIT, contentHash: HASH },
        { id: 'acme.notes', version: '1.0.0', commit: 'c'.repeat(40), contentHash: HASH },
      ],
    })
    expect(lock?.releases).toEqual([{ id: 'acme.notes', version: '1.0.0', commit: COMMIT, contentHash: HASH }])
  })
})

describe('the kill list', () => {
  const list = (extensions: unknown[]) => ({ killListVersion: 1, generatedAt: '2026-11-20T00:00:00Z', extensions })

  test('a version list kills those versions; none kills every version', () => {
    const read = readKillList(
      list([
        { id: 'acme.notes', versions: ['1.0.0'], reason: 'Leaks tokens.' },
        { id: 'acme.bad', reason: 'Malware.', advisoryUrl: 'https://example.com/advisory' },
      ]),
    )
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(findKilled(read.list, 'acme.notes', '1.0.0')?.reason).toBe('Leaks tokens.')
    expect(findKilled(read.list, 'acme.notes', '1.1.0')).toBeNull()
    expect(findKilled(read.list, 'acme.bad', '9.9.9')?.advisoryUrl).toBe('https://example.com/advisory')
  })

  test('a versions list Studio cannot read in full kills every version, and a bad entry hides no other', () => {
    const read = readKillList(
      list([{ id: 'acme.notes', versions: ['1.0.0', 7], reason: 'x', later: true }, { nope: 1 }, { id: 'acme.two' }]),
    )
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(findKilled(read.list, 'acme.notes', '5.0.0')).not.toBeNull()
    expect(findKilled(read.list, 'acme.two', '1.0.0')).not.toBeNull()
  })

  test('a repeated id kills what every entry for it kills', () => {
    const read = readKillList(
      list([
        { id: 'acme.notes', versions: ['1.0.0'], reason: 'First.' },
        { id: 'acme.notes', versions: ['1.1.0'], reason: 'Second.' },
        { id: 'acme.all', versions: ['1.0.0'], reason: 'One version.' },
        { id: 'acme.all', reason: 'Every version.' },
      ]),
    )
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(findKilled(read.list, 'acme.notes', '1.0.0')?.reason).toBe('First.')
    expect(findKilled(read.list, 'acme.notes', '1.1.0')).not.toBeNull()
    expect(findKilled(read.list, 'acme.notes', '1.2.0')).toBeNull()
    expect(findKilled(read.list, 'acme.all', '9.0.0')).not.toBeNull()
  })
})

describe('a release against the manifest it was made from', () => {
  test('the entry for a manifest matches it', () => {
    const made = catalogueReleaseEntry(manifest(), { commit: COMMIT, contentHash: HASH })
    expect(made.contributes).toEqual([{ kind: 'skills', name: 'notes' }])
    expect(catalogueReleaseMismatch({ release: made, manifest: manifest(), commit: COMMIT, contentHash: HASH })).toBe(
      null,
    )
  })

  test('each difference is said', () => {
    const base = { manifest: manifest(), commit: COMMIT, contentHash: HASH }
    expect(catalogueReleaseMismatch({ ...base, release: release({ commit: 'c'.repeat(40) }) })).toMatch(/commit/)
    expect(catalogueReleaseMismatch({ ...base, release: release({ contentHash: 'c'.repeat(64) }) })).toMatch(
      /content hash/,
    )
    expect(catalogueReleaseMismatch({ ...base, release: release({ version: '1.0.1' }) })).toMatch(/version/)
    expect(catalogueReleaseMismatch({ ...base, release: release({ permissions: ['notifications:show'] }) })).toMatch(
      /asks for/,
    )
    expect(catalogueReleaseMismatch({ ...base, release: release({ contributes: [] }) })).toMatch(/contributions/)
  })

  test('contributions are listed by point and name', () => {
    expect(
      catalogueContributions(
        manifest({
          contributes: {
            skills: [{ id: 'a', path: 'skills/a' }],
            mcpServers: [{ id: 'srv', name: 'Server', transport: 'http', url: 'https://example.com/mcp' }],
          },
        }),
      ),
    ).toEqual([
      { kind: 'skills', name: 'a' },
      { kind: 'mcpServers', name: 'srv' },
    ])
  })
})

describe('publishers and git URLs', () => {
  test('the publisher is the repository owner, lowercased', () => {
    expect(gitUrlPublisher('https://github.com/Acme/notes.git')).toBe('acme')
    expect(gitUrlPublisher('git@github.com:My_Org/notes.git')).toBe('my-org')
    expect(gitUrlPublisher('https://example.com/notes.git')).toBeNull()
  })

  test('on another host the publisher carries the host, so it cannot pass for the GitHub owner', () => {
    expect(gitUrlPublisher('https://evil.example/alice/notes')).toBe('from-evil-example-alice')
    expect(gitUrlPublisher('git@gitlab.com:alice/notes.git')).toBe('from-gitlab-com-alice')
    // The marked form is kept for other hosts: a GitHub owner named like one makes no publisher.
    expect(gitUrlPublisher('https://github.com/from-gitlab-com-alice/notes')).toBeNull()
    expect(gitUrlPublisher('https://github.com/From-Anything/notes')).toBeNull()
    // One that only looks like a host and an owner is a GitHub owner like any other.
    expect(gitUrlPublisher('https://github.com/gitlab-com-alice/notes')).toBe('gitlab-com-alice')
    expect(gitUrlPublisher('https://www.github.com/alice/notes')).toBe('alice')
    expect(gitUrlPublisher('ssh://git@github.com/alice/notes.git')).toBe('alice')
    // One that would be too long is no publisher at all.
    expect(gitUrlPublisher(`https://${'h'.repeat(30)}.example/alice/notes`)).toBeNull()
    // A host that spells a reserved publisher is marked, so it never takes one.
    expect(gitUrlPublisher('https://studio.example/alice/notes')).toBe('from-studio-example-alice')
    expect(gitUrlPublisher('https://sprintengine.example/official/notes')).toBe('from-sprintengine-example-official')
  })

  test('only HTTPS without credentials and SSH are fetched', () => {
    expect(isAllowedGitUrl('https://github.com/acme/notes.git')).toBe(true)
    expect(isAllowedGitUrl('ssh://git@github.com/acme/notes.git')).toBe(true)
    expect(isAllowedGitUrl('https://token@github.com/acme/notes.git')).toBe(false)
    expect(isAllowedGitUrl('file:///tmp/notes.git')).toBe(false)
    expect(isAllowedGitUrl('-oProxyCommand=x@host:repo')).toBe(false)
  })

  test('reserved publishers and ids', () => {
    expect(isReservedInstallKey('sprintengine.notes')).toBe(true)
    expect(isReservedInstallKey('studio-labs.notes')).toBe(true)
    expect(isReservedInstallKey('acme.studio-notes')).toBe(true)
    expect(isReservedInstallKey('acme.notes')).toBe(false)
  })

  test('one source however its URL is spelled; a moved folder is a move', () => {
    const https = { url: 'https://github.com/Acme/notes.git', ref: 'main', path: 'a' }
    expect(isSameCatalogueSource(https, { url: 'git@github.com:acme/notes', ref: 'v1', path: 'a' })).toBe(true)
    expect(isSameCatalogueSource(https, { ...https, path: 'b' })).toBe(false)
  })
})

describe('git sources and release-entry', () => {
  let work = ''
  let cli = ''
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'sprintengine-catalogue-'))
    const bin = join(work, 'bin')
    buildSync({
      entryPoints: [join(process.cwd(), 'packages/extension-sdk/src/cli.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: join(bin, 'cli.js'),
      external: ['react', 'react-dom', 'react-dom/*'],
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
      logLevel: 'silent',
    })
    writeFileSync(join(bin, 'package.json'), '{"type":"module"}')
    cli = join(bin, 'cli.js')
  })
  afterAll(() => rmSync(work, { recursive: true, force: true }))

  function repository(): { dir: string; folder: string } {
    const dir = join(work, `repo-${Math.random().toString(36).slice(2)}`)
    const folder = join(dir, 'extensions', 'notes')
    mkdirSync(join(folder, 'skills', 'notes'), { recursive: true })
    writeFileSync(join(folder, 'extension.json'), JSON.stringify(manifest(), null, 2))
    writeFileSync(
      join(folder, 'skills', 'notes', 'SKILL.md'),
      '---\nname: notes\ndescription: Notes.\n---\nTake notes.\n',
    )
    writeFileSync(join(dir, 'README.md'), 'A sibling file outside the extension.\n')
    git(dir, 'init', '--quiet', '--initial-branch=main')
    git(dir, 'config', 'user.email', 'dev@example.com')
    git(dir, 'config', 'user.name', 'Dev')
    git(dir, 'remote', 'add', 'origin', 'https://github.com/Acme/studio-extensions.git')
    git(dir, 'add', '.')
    git(dir, 'commit', '--quiet', '-m', 'notes')
    return { dir, folder }
  }

  /** Run `work` with git reading this as the person's global configuration. */
  async function withGlobalConfig<T>(config: Record<string, string>, action: () => Promise<T>): Promise<T> {
    const file = join(work, `gitconfig-${Math.random().toString(36).slice(2)}`)
    writeFileSync(file, '')
    for (const [key, value] of Object.entries(config)) execFileSync('git', ['config', '--file', file, key, value])
    const before = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = file
    try {
      return await action()
    } finally {
      if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = before
    }
  }

  const run = (args: string[]) => {
    const { status, stdout } = spawnSync(process.execPath, [cli, ...args, '--json'], { encoding: 'utf8' })
    return { status, answer: JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') }
  }

  test('release-entry prints the entry, the source path and the listing for HEAD', () => {
    const { dir, folder } = repository()
    const head = git(dir, 'rev-parse', 'HEAD')
    const { status, answer } = run(['release-entry', folder])
    expect(status).toBe(0)
    const expectedHash = extensionContentFingerprint(
      (computeModuleFileDigestsSync(folder) as { files: Record<string, string> }).files,
    )
    expect(answer.result).toEqual({
      entry: {
        version: '1.0.0',
        commit: head,
        contentHash: expectedHash,
        tier: 'declarative',
        minimumStudio: EXTENSION_MANIFEST_SINCE,
        permissions: [],
        contributes: [{ kind: 'skills', name: 'notes' }],
        name: 'Notes',
      },
      sourcePath: 'extensions/notes',
      listing: {
        id: 'acme.notes',
        source: {
          url: 'https://github.com/Acme/studio-extensions.git',
          ref: 'main',
          path: 'extensions/notes',
        },
      },
    })
    // What it prints is a release a catalogue validates.
    const listed = validateCatalogue(
      catalogue([{ id: 'acme.notes', source: answer.result.listing.source, releases: [answer.result.entry] }]),
    )
    expect(listed.ok).toBe(true)
  })

  test('release-entry says uncommitted changes are not in the release', () => {
    const { folder } = repository()
    writeFileSync(join(folder, 'skills', 'notes', 'SKILL.md'), 'changed\n')
    const { answer } = run(['release-entry', folder])
    expect(answer.result.note).toBe('uncommitted changes are not in this release; commit them first')
  })

  test('release-entry outside a repository has no entry', () => {
    const outside = mkdtempSync(join(tmpdir(), 'sprintengine-no-repo-'))
    try {
      const { status, answer } = run(['release-entry', outside])
      expect(status).toBe(2)
      expect(answer.error.message).toMatch(/not in a git repository/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('a fetched commit writes only the extension’s folder, hashed as release-entry hashes it', async () => {
    const { dir, folder } = repository()
    const bare = join(work, `bare-${Math.random().toString(36).slice(2)}.git`)
    git(work, 'clone', '--quiet', '--bare', dir, bare)
    const fetched = await fetchGitCommit({ url: `file://${bare}`, ref: 'main', allowFileUrls: true })
    try {
      expect(fetched.commit).toBe(git(dir, 'rev-parse', 'HEAD'))
      const out = join(work, `out-${Math.random().toString(36).slice(2)}`)
      await materializeGitTree({
        repository: fetched.repository,
        commit: fetched.commit,
        path: 'extensions/notes',
        destination: out,
      })
      const written = computeModuleFileDigestsSync(out) as { files: Record<string, string> }
      expect(Object.keys(written.files).sort()).toEqual(['extension.json', 'skills/notes/SKILL.md'])
      expect(written.files).toEqual((computeModuleFileDigestsSync(folder) as { files: Record<string, string> }).files)
    } finally {
      await fetched.dispose()
    }
  })

  /** A bare repository whose one commit holds these files (made without a working tree, so any spelling works). */
  function bareWith(files: Record<string, string>): string {
    const bare = join(work, `bare-${Math.random().toString(36).slice(2)}.git`)
    git(work, 'init', '--quiet', '--bare', bare)
    const env = { ...process.env, GIT_INDEX_FILE: join(bare, 'scratch-index') }
    for (const [path, text] of Object.entries(files)) {
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: bare, input: text, encoding: 'utf8' })
      execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${blob.trim()},${path}`], { cwd: bare, env })
    }
    const tree = execFileSync('git', ['write-tree'], { cwd: bare, env, encoding: 'utf8' }).trim()
    const commit = execFileSync('git', ['commit-tree', tree, '-m', 'files'], {
      cwd: bare,
      encoding: 'utf8',
      env: {
        ...env,
        GIT_AUTHOR_NAME: 'Dev',
        GIT_AUTHOR_EMAIL: 'dev@example.com',
        GIT_COMMITTER_NAME: 'Dev',
        GIT_COMMITTER_EMAIL: 'dev@example.com',
      },
    }).trim()
    git(bare, 'update-ref', 'refs/heads/main', commit)
    return bare
  }

  test('two spellings of one folder are refused, not only of one file', async () => {
    const bare = bareWith({ 'extension.json': '{}', 'Dir/a.js': 'a', 'dir/b.js': 'b' })
    const fetched = await fetchGitCommit({ url: `file://${bare}`, ref: 'main', allowFileUrls: true })
    try {
      await expect(
        materializeGitTree({
          repository: fetched.repository,
          commit: fetched.commit,
          destination: join(work, `out-${Math.random().toString(36).slice(2)}`),
        }),
      ).rejects.toThrow(/two paths a filesystem would read as one/)
    } finally {
      await fetched.dispose()
    }
  })

  test('a fetch past its size is stopped while it downloads', async () => {
    const bare = bareWith({ 'big.bin': randomBytes(4 * 1024 * 1024).toString('base64') })
    await expect(
      fetchGitCommit({ url: `file://${bare}`, ref: 'main', allowFileUrls: true, maxBytes: 64 * 1024 }),
    ).rejects.toThrow(/larger than Studio downloads/)
  })

  test('git runs here see an empty hooks folder and no automatic maintenance, whatever the person configured', async () => {
    const hooks = join(work, `hooks-${Math.random().toString(36).slice(2)}`)
    mkdirSync(hooks)
    const read = (key: string) =>
      withGlobalConfig({ 'core.hooksPath': hooks, 'maintenance.auto': 'true', 'gc.auto': '1' }, () =>
        runGit(['config', '--get', key], { cwd: work }),
      ).then((out) => out.toString('utf8').trim())
    const hooksPath = await read('core.hooksPath')
    expect(hooksPath).not.toBe(hooks)
    expect(readdirSync(hooksPath)).toEqual([])
    expect(await read('maintenance.auto')).toBe('false')
    expect(await read('gc.auto')).toBe('0')
  })

  test('a file:// URL is fetched only when allowed', async () => {
    await expect(fetchGitCommit({ url: `file://${work}/none.git`, ref: 'main' })).rejects.toThrow(/HTTPS or SSH/)
  })
})
