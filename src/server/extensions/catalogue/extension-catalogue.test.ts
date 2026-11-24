import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { EXTENSION_MANIFEST_SINCE } from '../../../../packages/extension-sdk/src/extension-manifest'
import { releaseEntryForHead } from '../../../../packages/extension-sdk/src/release-entry'
import type { CatalogueRelease } from '../../../../packages/extension-sdk/src/catalogue'
import { createModuleLifecycle } from '../../../main/modules/module-lifecycle'
import { createModuleRegistryMirror } from '../../../main/modules/registry-mirror'
import { NO_EXTENSION_RUN } from '../../../main/modules/third-party-module-view'
import { readInstallRecordsSync, readOwnerRecordsCacheSync, readReleaseLockSync } from './catalogue-files'
import { AUTO_UPDATE_HOLD_BACK_MS, type CatalogueNotice } from './extension-catalogue'
import { extensionCatalogueUrls } from './catalogue-fetch'

// Installing from a catalogue entry and from a git URL, the refusals, the
// kill list, and automatic updates, over a real lifecycle and local git
// repositories in a temporary folder: no network. A repository's owner is
// the folder it sits in (`<tmp>/repos/acme/notes`), as a git URL's owner is.

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

type Files = Record<string, string>

const SKILL = '---\nname: notes\ndescription: Take notes.\n---\nWrite things down.\n'

function notesManifest(over: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    id: 'notes',
    version: '1.0.0',
    engines: { studio: `>=${EXTENSION_MANIFEST_SINCE}` },
    tier: 'declarative',
    name: 'Notes',
    // A command running a Studio action asks for approval, and is not bound to the files.
    contributes: {
      skills: [{ id: 'notes', path: 'skills/notes' }],
      commands: [{ id: 'notes.settings', title: 'Notes settings', action: 'app.settings.open' }],
    },
    ...over,
  }
}

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sprintengine-catalogue-')))
  dirs.push(root)
  const dataDir = join(root, 'data')
  const moduleRoot = join(root, 'extensions')
  mkdirSync(dataDir, { recursive: true })
  const served = new Map<string, unknown>()
  const urls = extensionCatalogueUrls('https://catalogue.example.com/main')
  const notices: CatalogueNotice[] = []
  const warnings: string[] = []
  const imageFetches: string[] = []
  let clock = Date.parse('2026-11-20T00:00:00Z')
  // Every install reads the kill list first: an empty one unless a test says otherwise.
  served.set(urls.killList, { killListVersion: 1, generatedAt: '2026-11-19T00:00:00Z', extensions: [] })
  const lifecycle = createModuleLifecycle({
    dataDir,
    moduleRoot: () => moduleRoot,
    view: () => null,
    applyEnablement: async () => ({ ok: true }),
    changed: () => undefined,
    run: () => NO_EXTENSION_RUN,
    registry: createModuleRegistryMirror(),
    warn: (message) => warnings.push(message),
    catalogue: {
      urls,
      git: { allowFileUrls: true },
      now: () => clock,
      notify: (notice) => notices.push(notice),
      fetchJson: async (url) => {
        if (!served.has(url)) throw new Error(`${url} answered HTTP 404.`)
        return JSON.parse(JSON.stringify(served.get(url)))
      },
      fetchBytes: async (url) => {
        imageFetches.push(url)
        if (!served.has(url)) throw new Error(`${url} answered HTTP 404.`)
        return served.get(url) as Buffer
      },
    },
  })

  /** A repository holding an extension at `path`, committed; its file:// URL and folder. */
  function repository(owner: string, name: string, files: Files, path = '') {
    const dir = join(root, 'repos', owner, name)
    mkdirSync(dir, { recursive: true })
    git(dir, 'init', '--quiet', '--initial-branch=main')
    git(dir, 'config', 'user.email', 'dev@example.com')
    git(dir, 'config', 'user.name', 'Dev')
    const folder = path ? join(dir, path) : dir
    commit(folder, dir, files)
    return { dir, folder, url: `file://${dir}` }
  }

  function commit(folder: string, dir: string, files: Files): string {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(folder, file, '..'), { recursive: true })
      writeFileSync(join(folder, file), text)
    }
    git(dir, 'add', '-A')
    git(dir, 'commit', '--quiet', '--allow-empty', '-m', 'change')
    return git(dir, 'rev-parse', 'HEAD')
  }

  async function release(folder: string): Promise<CatalogueRelease> {
    const report = await releaseEntryForHead(folder)
    if (!report.entry) throw new Error(report.note)
    return report.entry
  }

  function serveCatalogue(which: 'official' | 'community', extensions: unknown[], owner = 'sprintengine') {
    served.set(urls[which], {
      catalogueVersion: 1,
      name: which === 'official' ? 'Official' : 'Community',
      owner,
      extensions,
    })
  }

  function serveKillList(extensions: unknown[], generatedAt = '2026-11-21T00:00:00Z') {
    served.set(urls.killList, { killListVersion: 1, generatedAt, extensions })
  }

  const installed = async () => (await lifecycle.installed()).modules

  return {
    root,
    dataDir,
    moduleRoot,
    lifecycle,
    served,
    urls,
    notices,
    repository,
    commit,
    release,
    serveCatalogue,
    serveKillList,
    installed,
    warnings,
    imageFetches,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

const notesFiles = (over: Record<string, unknown> = {}, skill = SKILL): Files => ({
  'extension.json': JSON.stringify(notesManifest(over), null, 2),
  'skills/notes/SKILL.md': skill,
})

async function approveAll(env: ReturnType<typeof setup>) {
  for (const module of await env.installed())
    if (module.approval.state === 'pending')
      await env.lifecycle.approve(module.manifest.id, module.approval.fingerprint)
}

describe('installing from a catalogue entry', () => {
  test('installs the pinned commit’s folder under the owner’s key, and records where it came from', async () => {
    const env = setup()
    const repo = env.repository('acme', 'studio-extensions', notesFiles(), 'notes')
    const entry = {
      id: 'acme.notes',
      source: { url: repo.url, ref: 'main', path: 'notes' },
      ownerId: 7,
      releases: [await env.release(repo.folder)],
    }
    env.serveCatalogue('community', [entry])
    // A later commit on the branch is not what the release pins.
    env.commit(repo.folder, repo.dir, { 'skills/notes/SKILL.md': `${SKILL}\nLater.\n` })

    const answer = await env.lifecycle.catalogue.installFrom({ catalogue: 'community', id: 'acme.notes' })
    expect(answer).toMatchObject({ ok: true, moduleId: 'acme.notes', approval: { state: 'pending' } })
    expect(readFileSync(join(env.moduleRoot, 'acme.notes', 'skills/notes/SKILL.md'), 'utf8')).toBe(SKILL)
    expect(existsSync(join(env.moduleRoot, 'acme.notes', 'README.md'))).toBe(false)
    const record = readInstallRecordsSync(env.dataDir)['acme.notes']
    expect(record).toMatchObject({
      origin: { kind: 'catalogue', catalogue: 'community' },
      version: '1.0.0',
      ownerId: 7,
    })
    const [view] = await env.installed()
    expect(view?.origin).toMatchObject({ kind: 'community', label: 'Community · acme' })
  })

  test('refuses bytes whose hash differs from the release’s contentHash', async () => {
    const env = setup()
    const repo = env.repository('acme', 'notes', notesFiles())
    const pinned = await env.release(repo.folder)
    env.serveCatalogue('community', [
      {
        id: 'acme.notes',
        source: { url: repo.url, ref: 'main' },
        releases: [{ ...pinned, contentHash: 'f'.repeat(64) }],
      },
    ])
    const answer = await env.lifecycle.catalogue.installFrom({ catalogue: 'community', id: 'acme.notes' })
    expect(answer).toMatchObject({ ok: false })
    expect(!answer.ok && answer.message).toMatch(/content hash/)
    expect(existsSync(join(env.moduleRoot, 'acme.notes'))).toBe(false)
  })

  test('refuses a manifest that differs from what the entry declares', async () => {
    const env = setup()
    const repo = env.repository('acme', 'notes', notesFiles())
    const pinned = await env.release(repo.folder)
    env.serveCatalogue('community', [
      {
        id: 'acme.notes',
        source: { url: repo.url, ref: 'main' },
        releases: [{ ...pinned, contributes: [{ kind: 'skills', name: 'notes' }] }],
      },
    ])
    const answer = await env.lifecycle.catalogue.installFrom({ catalogue: 'community', id: 'acme.notes' })
    expect(!answer.ok && answer.message).toMatch(/other contributions than the catalogue lists/)
  })

  test('a reserved publisher installs only from the official catalogue; another catalogue listing one is refused whole', async () => {
    const env = setup()
    const repo = env.repository('sprintengine', 'notes', notesFiles())
    const entry = {
      id: 'sprintengine.notes',
      source: { url: repo.url, ref: 'main' },
      releases: [await env.release(repo.folder)],
    }
    env.serveCatalogue('community', [entry])
    const refused = await env.lifecycle.catalogue.installFrom({ catalogue: 'community', id: 'sprintengine.notes' })
    expect(!refused.ok && refused.message).toMatch(/only Studio’s official catalogue/)
    const community = (await env.lifecycle.catalogue.catalogues(true)).find((catalogue) => catalogue.id === 'community')
    expect(community?.error).toMatch(/only Studio’s official catalogue may list/)
    expect(community?.entries).toEqual([])

    env.serveCatalogue('official', [entry])
    const official = await env.lifecycle.catalogue.installFrom({ catalogue: 'official', id: 'sprintengine.notes' })
    expect(official).toMatchObject({ ok: true, moduleId: 'sprintengine.notes' })
    const [view] = await env.installed()
    expect(view?.origin?.label).toBe('Official')
  })

  test('a catalogue re-pointing a listed version is refused: a version keeps the commit it was first seen at', async () => {
    const env = setup()
    const repo = env.repository('acme', 'notes', notesFiles())
    const first = await env.release(repo.folder)
    env.serveCatalogue('community', [{ id: 'acme.notes', source: { url: repo.url, ref: 'main' }, releases: [first] }])
    expect(await env.lifecycle.catalogue.installFrom({ catalogue: 'community', id: 'acme.notes' })).toMatchObject({
      ok: true,
    })

    env.commit(repo.folder, repo.dir, { 'skills/notes/SKILL.md': `${SKILL}\nSwapped.\n` })
    const moved = await env.release(repo.folder)
    expect(moved.version).toBe(first.version)
    env.serveCatalogue('community', [{ id: 'acme.notes', source: { url: repo.url, ref: 'main' }, releases: [moved] }])
    const answer = await env.lifecycle.catalogue.installFrom({ catalogue: 'community', id: 'acme.notes' })
    expect(!answer.ok && answer.message).toMatch(
      /a listed version never moves.*remove acme\.notes and install it again/,
    )

    // Removing it starts afresh: the person installs what the catalogue lists now.
    await env.lifecycle.uninstall('acme.notes')
    expect(await env.lifecycle.catalogue.installFrom({ catalogue: 'community', id: 'acme.notes' })).toMatchObject({
      ok: true,
    })
  })
})

describe('installing from a git URL', () => {
  test('a new commit at an unchanged version is the person’s install; Studio’s release lock still pins a listed one', async () => {
    const env = setup()
    const repo = env.repository('acme', 'notes', notesFiles())
    git(repo.dir, 'tag', 'v1.0.0')
    const first = await env.lifecycle.catalogue.installFrom({ git: repo.url, ref: 'v1.0.0' })
    expect(first).toMatchObject({ ok: true, moduleId: 'acme.notes' })
    const [view] = await env.installed()
    expect(view?.origin?.label).toBe('Unverified')
    const pinned = view!.origin!.commit!

    // A plugin that never bumps its version still takes its changes.
    env.commit(repo.folder, repo.dir, { 'skills/notes/SKILL.md': `${SKILL}\nNot the same bytes.\n` })
    git(repo.dir, 'tag', '--force', 'v1.0.0')
    expect(await env.lifecycle.catalogue.installFrom({ git: repo.url, ref: 'v1.0.0' })).toMatchObject({ ok: true })

    // A version the catalogue repository's release lock pins is held to its bytes.
    env.served.set(env.urls.releaseLock, {
      lockVersion: 1,
      releases: [{ id: 'acme.notes', version: '1.0.0', commit: pinned, contentHash: 'f'.repeat(64) }],
    })
    env.commit(repo.folder, repo.dir, { 'skills/notes/SKILL.md': `${SKILL}\nOther bytes again.\n` })
    const locked = await env.lifecycle.catalogue.installFrom({ git: repo.url })
    expect(!locked.ok && locked.message).toMatch(/locked to commit .* in Studio’s release lock.*publish a new version/)
  })

  test('a Claude Code plugin repository becomes an extension of its skills and MCP servers', async () => {
    const env = setup()
    const repo = env.repository('acme', 'review-kit', {
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'review-kit', version: '2.1.0', description: 'Reviews.' }),
      'skills/checklist/SKILL.md': '---\nname: checklist\ndescription: A review checklist.\n---\nCheck it.\n',
      '.mcp.json': JSON.stringify({
        mcpServers: {
          lint: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'] },
          docs: { type: 'http', url: 'https://docs.example.com/mcp' },
        },
      }),
      'server.js': 'process.stdin.resume()\n',
      'commands/review.md': 'Review this.\n',
    })
    const answer = await env.lifecycle.catalogue.installFrom({ git: repo.url })
    expect(answer).toMatchObject({ ok: true, moduleId: 'acme.review-kit', leftOut: ['slash commands'] })
    const [view] = await env.installed()
    expect(view?.extension).toMatchObject({ version: '2.1.0', tier: 'declarative' })
    expect(view?.extension.contributes.skills).toEqual([{ id: 'checklist', path: 'skills/checklist' }])
    expect(view?.extension.contributes.mcpServers).toEqual([
      { id: 'lint', name: 'lint', transport: 'stdio', command: 'node', args: ['${extensionPath}/server.js'] },
      { id: 'docs', name: 'docs', transport: 'http', url: 'https://docs.example.com/mcp' },
    ])
    // A local server asks once, at install.
    expect(view?.approval.state).toBe('pending')
  })

  test('a plugin’s MCP servers in both places are merged, and everything dropped is named', async () => {
    const env = setup()
    const repo = env.repository('acme', 'review-kit', {
      '.claude-plugin/plugin.json': JSON.stringify({
        name: 'review-kit',
        version: '1.0.0',
        outputStyles: './styles',
        lspServers: {},
        mcpServers: {
          lint: { command: 'node', args: ['other.js'] },
          search: { type: 'sse', url: 'https://search.example.com/sse', headers: { Authorization: 'x' } },
        },
      }),
      'skills/checklist/SKILL.md': '---\nname: checklist\ndescription: A review checklist.\n---\nCheck it.\n',
      '.mcp.json': JSON.stringify({ mcpServers: { lint: { command: 'node', args: ['server.js'] } } }),
    })
    const answer = await env.lifecycle.catalogue.installFrom({ git: repo.url })
    expect(answer).toMatchObject({ ok: true })
    const leftOut = answer.ok ? (answer.leftOut ?? []) : []
    expect(leftOut).toEqual(
      expect.arrayContaining([
        'output styles',
        'plugin.json\'s "lspServers"',
        'plugin.json\'s MCP server "lint" (.mcp.json\'s of that name is used)',
        'the HTTP headers of MCP server "search"',
        'the SSE transport of MCP server "search" (Studio reaches it over HTTP)',
      ]),
    )
    const [view] = await env.installed()
    expect(view?.extension.contributes.mcpServers).toEqual([
      { id: 'lint', name: 'lint', transport: 'stdio', command: 'node', args: ['server.js'] },
      { id: 'search', name: 'search', transport: 'http', url: 'https://search.example.com/sse' },
    ])
  })

  test('a plugin marketplace repository names its plugin folders, and one installs by its folder', async () => {
    const env = setup()
    const repo = env.repository('acme', 'plugins', {
      '.claude-plugin/marketplace.json': JSON.stringify({
        name: 'acme',
        owner: { name: 'Acme' },
        plugins: [
          { name: 'review-kit', source: './plugins/review-kit' },
          { name: 'remote', source: { source: 'github' } },
        ],
      }),
      'plugins/review-kit/.claude-plugin/plugin.json': JSON.stringify({ name: 'review-kit', version: '1.0.0' }),
      'plugins/review-kit/skills/checklist/SKILL.md':
        '---\nname: checklist\ndescription: A review checklist.\n---\nCheck it.\n',
    })
    const root = await env.lifecycle.catalogue.installFrom({ git: repo.url })
    expect(root).toMatchObject({ ok: false, folders: ['plugins/review-kit'] })
    expect(!root.ok && root.message).toMatch(
      /plugin marketplace\. Name the folder of the plugin to install: plugins\/review-kit/,
    )
    expect(await env.lifecycle.catalogue.installFrom({ git: repo.url, path: 'plugins/review-kit' })).toMatchObject({
      ok: true,
      moduleId: 'acme.review-kit',
    })
  })

  test('an install from a catalogue is not taken over by a git URL', async () => {
    const env = setup()
    const repo = env.repository('acme', 'notes', notesFiles())
    env.serveCatalogue('community', [
      { id: 'acme.notes', source: { url: repo.url, ref: 'main' }, releases: [await env.release(repo.folder)] },
    ])
    await env.lifecycle.catalogue.installFrom({ catalogue: 'community', id: 'acme.notes' })
    const answer = await env.lifecycle.catalogue.installFrom({ git: repo.url })
    expect(!answer.ok && answer.message).toMatch(/remove it first/)
  })
})

describe('the kill list', () => {
  test('a killed version is switched off, what it added is retracted, and it cannot be installed again', async () => {
    const env = setup()
    const repo = env.repository('acme', 'notes', notesFiles())
    env.serveCatalogue('community', [
      { id: 'acme.notes', source: { url: repo.url, ref: 'main' }, releases: [await env.release(repo.folder)] },
    ])
    await env.lifecycle.catalogue.installFrom({ catalogue: 'community', id: 'acme.notes' })
    await approveAll(env)
    expect((await env.installed())[0]?.launch.status).not.toBe('killed')

    env.serveKillList([{ id: 'acme.notes', versions: ['1.0.0'], reason: 'It sends your files away.' }])
    await env.lifecycle.catalogue.killList.refresh()
    const [view] = await env.installed()
    expect(view?.killed).toEqual({ reason: 'It sends your files away.' })
    expect(view?.launch.status).toBe('killed')
    expect(env.notices).toContainEqual(
      expect.objectContaining({ key: 'acme.notes', severity: 'error', title: 'Notes was switched off' }),
    )
    // Nothing it handed agents is projected any more.
    const projected = JSON.stringify(readdirDeep(join(env.dataDir)))
    expect(projected).not.toMatch(/acme\.notes.*SKILL\.md/)

    await env.lifecycle.uninstall('acme.notes')
    const again = await env.lifecycle.catalogue.installFrom({ catalogue: 'community', id: 'acme.notes' })
    expect(!again.ok && again.message).toMatch(/kill list removed acme\.notes 1\.0\.0/)
  })

  test('an older or far-future kill list is refused', async () => {
    const env = setup()
    env.serveKillList([], '2026-11-21T00:00:00Z')
    await env.lifecycle.catalogue.killList.refresh()
    env.serveKillList([{ id: 'acme.notes', reason: 'x' }], '2026-11-01T00:00:00Z')
    await expect(env.lifecycle.catalogue.killList.refresh()).rejects.toThrow(/older/)
    env.serveKillList([], '2027-11-01T00:00:00Z')
    await expect(env.lifecycle.catalogue.killList.refresh()).rejects.toThrow(/too far ahead/)
  })
})

describe('automatic updates', () => {
  async function installedV1(env: ReturnType<typeof setup>, ownerId?: number) {
    const repo = env.repository('acme', 'notes', notesFiles())
    const v1 = await env.release(repo.folder)
    const entry = (releases: CatalogueRelease[], extra: Record<string, unknown> = {}) => ({
      id: 'acme.notes',
      source: { url: repo.url, ref: 'main' },
      ...(ownerId !== undefined ? { ownerId } : {}),
      releases,
      ...extra,
    })
    env.serveCatalogue('community', [entry([v1])])
    env.serveKillList([])
    await env.lifecycle.catalogue.installFrom({ catalogue: 'community', id: 'acme.notes' })
    await approveAll(env)
    expect((await env.installed())[0]?.approval.state).toBe('approved')
    return { repo, v1, entry }
  }

  test('an update that asks for no more installs quietly, keeps its approval, and says so', async () => {
    const env = setup()
    const { repo, v1, entry } = await installedV1(env)
    env.commit(repo.folder, repo.dir, {
      'extension.json': JSON.stringify(notesManifest({ version: '1.1.0' }), null, 2),
      'skills/notes/SKILL.md': `${SKILL}\nBetter notes.\n`,
    })
    const v2 = await env.release(repo.folder)
    env.serveCatalogue('community', [entry([v2, v1])])

    // Held back until the release has been listed long enough for a takedown to land.
    await env.lifecycle.catalogue.runUpdates()
    expect((await env.installed())[0]?.extension.version).toBe('1.0.0')
    env.advance(AUTO_UPDATE_HOLD_BACK_MS + 1)
    await env.lifecycle.catalogue.runUpdates()

    const [view] = await env.installed()
    expect(env.warnings).toEqual([])
    expect(view?.update).toBeUndefined()
    expect(view?.extension.version).toBe('1.1.0')
    expect(view?.approval.state).toBe('approved')
    expect(env.notices).toContainEqual(expect.objectContaining({ title: 'Notes updated to 1.1.0', severity: 'info' }))
  })

  test('an update whose access grows waits for approval, with a notice, and the running version keeps running', async () => {
    const env = setup()
    const { repo, v1, entry } = await installedV1(env)
    env.commit(repo.folder, repo.dir, {
      'extension.json': JSON.stringify(
        notesManifest({
          version: '1.1.0',
          contributes: {
            skills: [{ id: 'notes', path: 'skills/notes' }],
            commands: [{ id: 'notes.settings', title: 'Notes settings', action: 'app.settings.open' }],
            mcpServers: [{ id: 'notes', name: 'Notes', transport: 'stdio', command: 'npx', args: ['some-server'] }],
          },
        }),
        null,
        2,
      ),
    })
    const v2 = await env.release(repo.folder)
    env.serveCatalogue('community', [entry([v2, v1])])
    env.advance(AUTO_UPDATE_HOLD_BACK_MS + 1)
    await env.lifecycle.catalogue.runUpdates()
    env.advance(AUTO_UPDATE_HOLD_BACK_MS + 1)
    await env.lifecycle.catalogue.runUpdates()

    const [view] = await env.installed()
    expect(view?.extension.version).toBe('1.0.0')
    expect(view?.approval.state).toBe('approved')
    expect(view?.update).toMatchObject({ version: '1.1.0', held: 'access' })
    expect(view?.update?.growth?.join(' ')).toMatch(/local MCP server "notes"/)
    const held = env.notices.filter((notice) => notice.title === 'Notes 1.1.0 waits for your review')
    expect(held).toHaveLength(1)

    // Reviewing it installs it, and it asks again.
    const updated = await env.lifecycle.catalogue.update('acme.notes')
    expect(updated).toMatchObject({ ok: true, approval: { state: 'pending' } })
    expect((await env.installed())[0]?.update).toBeUndefined()
  })

  test('a renamed or transferred owner pauses updates', async () => {
    const env = setup()
    const { repo, v1, entry } = await installedV1(env, 7)
    env.commit(repo.folder, repo.dir, {
      'extension.json': JSON.stringify(notesManifest({ version: '1.1.0' }), null, 2),
    })
    const v2 = await env.release(repo.folder)
    env.serveCatalogue('community', [entry([v2, v1], { ownerId: 8 })])
    env.advance(AUTO_UPDATE_HOLD_BACK_MS + 1)
    await env.lifecycle.catalogue.runUpdates()

    const [view] = await env.installed()
    expect(view?.extension.version).toBe('1.0.0')
    expect(view?.update).toMatchObject({ version: '1.1.0', held: 'owner' })
    const manual = await env.lifecycle.catalogue.update('acme.notes')
    expect(!manual.ok && manual.message).toMatch(/Updates are paused/)

    // The owner records say the same of a rename, with the catalogue silent on the id.
    env.serveCatalogue('community', [entry([v2, v1])])
    env.served.set(env.urls.owners, { ownersVersion: 1, owners: [{ login: 'acme-renamed', id: 7 }] })
    const renamed = await env.lifecycle.catalogue.update('acme.notes')
    expect(!renamed.ok && renamed.message).toMatch(/now named acme-renamed/)
  })
})

describe('what installs is exactly what was checked', () => {
  async function installedV1(env: ReturnType<typeof setup>, ownerId?: number) {
    const repo = env.repository('acme', 'notes', notesFiles())
    const v1 = await env.release(repo.folder)
    const entry = (releases: CatalogueRelease[], extra: Record<string, unknown> = {}) => ({
      id: 'acme.notes',
      source: { url: repo.url, ref: 'main' },
      ...(ownerId !== undefined ? { ownerId } : {}),
      releases,
      ...extra,
    })
    env.serveCatalogue('community', [entry([v1])])
    await env.lifecycle.catalogue.installFrom({ catalogue: 'community', id: 'acme.notes' })
    await approveAll(env)
    return { repo, v1, entry }
  }

  async function v2Of(env: ReturnType<typeof setup>, repo: { folder: string; dir: string }) {
    env.commit(repo.folder, repo.dir, {
      'extension.json': JSON.stringify(notesManifest({ version: '1.1.0' }), null, 2),
      'skills/notes/SKILL.md': `${SKILL}\nBetter notes.\n`,
    })
    return env.release(repo.folder)
  }

  test('an aged release does not become a newer one from another repository, listed meanwhile', async () => {
    const env = setup()
    const { repo, v1, entry } = await installedV1(env)
    const v2 = await v2Of(env, repo)
    env.serveCatalogue('community', [entry([v2, v1])])
    await env.lifecycle.catalogue.runUpdates()
    env.advance(AUTO_UPDATE_HOLD_BACK_MS + 1)

    const fork = env.repository('acme', 'notes-fork', notesFiles({ version: '1.2.0' }))
    const v3 = await env.release(fork.folder)
    const withV2 = env.served.get(env.urls.community)
    env.serveCatalogue('community', [{ ...entry([v3, v2, v1]), source: { url: fork.url, ref: 'main' } }])
    const withV3 = env.served.get(env.urls.community)
    // The pass reads 1.1.0, aged; the read just before the install finds 1.2.0 from the fork.
    let reads = 0
    const get = env.served.get.bind(env.served)
    env.served.get = (url: string) => (url === env.urls.community ? (reads++ === 0 ? withV2 : withV3) : get(url))
    await env.lifecycle.catalogue.runUpdates()

    expect((await env.installed())[0]?.extension.version).toBe('1.0.0')
    expect(env.warnings.join('\n')).toMatch(/now lists acme\.notes 1\.2\.0, not 1\.1\.0/)
    expect(env.notices.filter((notice) => notice.severity === 'info')).toEqual([])
    // The next pass checks 1.2.0 in its turn: it moved, so it waits for the person.
    await env.lifecycle.catalogue.runUpdates()
    expect((await env.installed())[0]?.update).toMatchObject({ version: '1.2.0', held: 'repository' })
  })

  test('"Review version X" refuses when the catalogue lists another release now', async () => {
    const env = setup()
    const { repo, v1, entry } = await installedV1(env)
    env.commit(repo.folder, repo.dir, {
      'extension.json': JSON.stringify(
        notesManifest({
          version: '1.1.0',
          contributes: {
            skills: [{ id: 'notes', path: 'skills/notes' }],
            commands: [{ id: 'notes.settings', title: 'Notes settings', action: 'app.settings.open' }],
            mcpServers: [{ id: 'notes', name: 'Notes', transport: 'stdio', command: 'npx', args: ['some-server'] }],
          },
        }),
        null,
        2,
      ),
    })
    const v2 = await env.release(repo.folder)
    env.serveCatalogue('community', [entry([v2, v1])])
    env.advance(AUTO_UPDATE_HOLD_BACK_MS + 1)
    await env.lifecycle.catalogue.runUpdates()
    env.advance(AUTO_UPDATE_HOLD_BACK_MS + 1)
    await env.lifecycle.catalogue.runUpdates()
    expect((await env.installed())[0]?.update).toMatchObject({ version: '1.1.0', held: 'access' })

    // 1.1.0 re-pointed at other bytes after it was held.
    env.commit(repo.folder, repo.dir, { 'skills/notes/SKILL.md': `${SKILL}\nSwapped.\n` })
    const swapped = await env.release(repo.folder)
    env.serveCatalogue('community', [entry([swapped, v1])])
    const changed = await env.lifecycle.catalogue.update('acme.notes', '1.1.0')
    expect(!changed.ok && changed.message).toMatch(/changed acme\.notes 1\.1\.0 since it was held/)

    // A newer release than the one shown.
    env.commit(repo.folder, repo.dir, {
      'extension.json': JSON.stringify(notesManifest({ version: '1.2.0' }), null, 2),
    })
    const v3 = await env.release(repo.folder)
    env.serveCatalogue('community', [entry([v3, v2, v1])])
    const newer = await env.lifecycle.catalogue.update('acme.notes', '1.1.0')
    expect(!newer.ok && newer.message).toMatch(/now lists acme\.notes 1\.2\.0, not 1\.1\.0/)
    expect((await env.installed())[0]?.extension.version).toBe('1.0.0')
  })

  /** What a page's Install names: the whole release its page shows. */
  async function shown(env: ReturnType<typeof setup>, catalogue: string, id: string) {
    const page = await env.lifecycle.catalogue.entry(catalogue, id)
    if (!page.ok) throw new Error(page.message)
    const { version, commit, contentHash, source, ownerId } = page.entry
    return { catalogue, id, version, commit, contentHash, source, ownerId: ownerId ?? null }
  }

  test('a catalogue install names the release the page showed', async () => {
    const env = setup()
    const repo = env.repository('acme', 'notes', notesFiles())
    const v1 = await env.release(repo.folder)
    env.serveCatalogue('community', [{ id: 'acme.notes', source: { url: repo.url, ref: 'main' }, releases: [v1] }])
    const page = await shown(env, 'community', 'acme.notes')
    const v2 = await v2Of(env, repo)
    env.serveCatalogue('community', [{ id: 'acme.notes', source: { url: repo.url, ref: 'main' }, releases: [v2, v1] }])
    const answer = await env.lifecycle.catalogue.installFrom(page)
    expect(!answer.ok && answer.message).toMatch(/now lists acme\.notes 1\.1\.0, not 1\.0\.0/)
    expect(await env.installed()).toEqual([])
  })

  test('a page’s Install refuses another folder at the same commit and version, and another owner', async () => {
    const env = setup()
    // One commit holding the extension twice: the folder the page showed, and another.
    const dir = join(env.root, 'repos', 'acme', 'extensions')
    const repo = env.repository('acme', 'extensions', notesFiles(), 'notes')
    env.commit(join(dir, 'other'), dir, notesFiles())
    const release = await env.release(repo.folder)
    const listed = (path: string, ownerId: number) => ({
      id: 'acme.notes',
      source: { url: repo.url, ref: 'main', path },
      ownerId,
      releases: [release],
    })
    env.serveCatalogue('community', [listed('notes', 7)])
    const page = await shown(env, 'community', 'acme.notes')
    expect(page).toMatchObject({ source: { path: 'notes' }, ownerId: 7, contentHash: release.contentHash })

    // Same version, commit and bytes, another folder: refused, nothing installed.
    env.serveCatalogue('community', [listed('other', 7)])
    const moved = await env.lifecycle.catalogue.installFrom(page)
    expect(!moved.ok && moved.message).toMatch(/moved to another repository or folder\. Look at it again/)
    expect(await env.installed()).toEqual([])

    // Back in its folder, under another owner id: refused too.
    env.serveCatalogue('community', [listed('notes', 8)])
    const owner = await env.lifecycle.catalogue.installFrom(page)
    expect(!owner.ok && owner.message).toMatch(/its owner changed/)
    expect(await env.installed()).toEqual([])

    // As shown: installs.
    env.serveCatalogue('community', [listed('notes', 7)])
    expect(await env.lifecycle.catalogue.installFrom(page)).toMatchObject({ ok: true, moduleId: 'acme.notes' })
  })
})

describe('the kill list before every install', () => {
  test('with no kill list read and none kept, nothing installs; with one kept, it is used', async () => {
    const env = setup()
    const repo = env.repository('acme', 'notes', notesFiles())
    env.serveCatalogue('community', [
      { id: 'acme.notes', source: { url: repo.url, ref: 'main' }, releases: [await env.release(repo.folder)] },
    ])
    env.served.delete(env.urls.killList)
    const catalogue = await env.lifecycle.catalogue.installFrom({ catalogue: 'community', id: 'acme.notes' })
    expect(!catalogue.ok && catalogue.message).toMatch(/could not read its kill list, so nothing installs/)
    const fromGit = await env.lifecycle.catalogue.installFrom({ git: repo.url })
    expect(!fromGit.ok && fromGit.message).toMatch(/could not read its kill list/)
    expect(await env.installed()).toEqual([])

    env.serveKillList([])
    await env.lifecycle.catalogue.killList.refresh()
    env.served.delete(env.urls.killList)
    expect(await env.lifecycle.catalogue.installFrom({ catalogue: 'community', id: 'acme.notes' })).toMatchObject({
      ok: true,
    })
    expect(env.warnings.join('\n')).toMatch(/checked against the kept copy/)
  })

  test('a version killed since the last read is refused at install', async () => {
    const env = setup()
    const repo = env.repository('acme', 'notes', notesFiles())
    env.serveCatalogue('community', [
      { id: 'acme.notes', source: { url: repo.url, ref: 'main' }, releases: [await env.release(repo.folder)] },
    ])
    env.serveKillList([{ id: 'acme.notes', versions: ['1.0.0'], reason: 'It sends your files away.' }])
    const answer = await env.lifecycle.catalogue.installFrom({ catalogue: 'community', id: 'acme.notes' })
    expect(!answer.ok && answer.message).toMatch(/kill list removed acme\.notes 1\.0\.0/)
  })
})

describe('an install keeps its source', () => {
  test('another repository, another kind of source or another catalogue is refused until it is removed', async () => {
    const env = setup()
    const repo = env.repository('acme', 'notes', notesFiles())
    const copy = env.repository('acme', 'notes-copy', notesFiles())
    expect(await env.lifecycle.catalogue.installFrom({ git: repo.url })).toMatchObject({ ok: true })
    const otherRepository = await env.lifecycle.catalogue.installFrom({ git: copy.url })
    expect(!otherRepository.ok && otherRepository.message).toMatch(/installed from the git URL .*remove it first/)
    // The same repository at another ref is the same source.
    expect(await env.lifecycle.catalogue.installFrom({ git: repo.url, ref: 'main' })).toMatchObject({ ok: true })

    env.serveCatalogue('community', [
      { id: 'acme.notes', source: { url: repo.url, ref: 'main' }, releases: [await env.release(repo.folder)] },
    ])
    const toCatalogue = await env.lifecycle.catalogue.installFrom({ catalogue: 'community', id: 'acme.notes' })
    expect(!toCatalogue.ok && toCatalogue.message).toMatch(/installed from the git URL .*remove it first/)

    await env.lifecycle.uninstall('acme.notes')
    expect(await env.lifecycle.catalogue.installFrom({ catalogue: 'community', id: 'acme.notes' })).toMatchObject({
      ok: true,
    })
    env.serveCatalogue('official', [
      { id: 'acme.notes', source: { url: repo.url, ref: 'main' }, releases: [await env.release(repo.folder)] },
    ])
    const toOfficial = await env.lifecycle.catalogue.installFrom({ catalogue: 'official', id: 'acme.notes' })
    expect(!toOfficial.ok && toOfficial.message).toMatch(/installed from Community; remove it first/)
  })
})

describe('the release lock and the owner records', () => {
  test('another catalogue listing the same id locks nothing for the install', async () => {
    const env = setup()
    const repo = env.repository('acme', 'notes', notesFiles())
    const v1 = await env.release(repo.folder)
    env.serveCatalogue('community', [{ id: 'acme.notes', source: { url: repo.url, ref: 'main' }, releases: [v1] }])
    await env.lifecycle.catalogue.installFrom({ catalogue: 'community', id: 'acme.notes' })

    // A fork lists 1.1.0 first, at its own bytes.
    const fork = env.repository('mallory', 'notes', notesFiles({ version: '1.1.0' }))
    const forked = await env.release(fork.folder)
    const index = env.repository('mallory', 'catalogue', {
      'catalogue.json': JSON.stringify({
        catalogueVersion: 1,
        name: 'Mirror',
        owner: 'mallory',
        extensions: [{ id: 'acme.notes', source: { url: fork.url, ref: 'main' }, releases: [forked, v1] }],
      }),
    })
    expect(await env.lifecycle.catalogue.add(index.url)).toMatchObject({ ok: true })
    await env.lifecycle.catalogue.catalogues(true)
    expect(readReleaseLockSync(env.dataDir)['acme.notes']?.['1.1.0']).toBeUndefined()

    // The real 1.1.0 installs from the catalogue it came from.
    const v2 = await (async () => {
      env.commit(repo.folder, repo.dir, {
        'extension.json': JSON.stringify(notesManifest({ version: '1.1.0' }), null, 2),
      })
      return env.release(repo.folder)
    })()
    env.serveCatalogue('community', [{ id: 'acme.notes', source: { url: repo.url, ref: 'main' }, releases: [v2, v1] }])
    expect(await env.lifecycle.catalogue.update('acme.notes', '1.1.0')).toMatchObject({ ok: true })
    await env.lifecycle.catalogue.dispose()
  })

  test('disposing lets go of an added catalogue’s checkout, and a read that lands after is not kept', async () => {
    const env = setup()
    const index = env.repository('acme', 'catalogue', {
      'catalogue.json': JSON.stringify({ catalogueVersion: 1, name: 'Acme', owner: 'acme', extensions: [] }),
    })
    // The checkouts go to the temporary folder: this test's own, to count them.
    const temp = join(env.root, 'tmp')
    mkdirSync(temp)
    const before = process.env.TMPDIR
    process.env.TMPDIR = temp
    const checkouts = () => readdirSync(temp).filter((name) => name.startsWith('sprintengine-extension-git-'))
    try {
      expect(await env.lifecycle.catalogue.add(index.url)).toMatchObject({ ok: true })
      expect(checkouts()).toHaveLength(1)
      await env.lifecycle.catalogue.dispose()
      expect(checkouts()).toEqual([])
      await env.lifecycle.catalogue.catalogues(true)
      expect(checkouts()).toEqual([])
    } finally {
      if (before === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = before
    }
  })

  test('an owner Studio cannot read pauses updates; one learned later is recorded', async () => {
    const env = setup()
    const repo = env.repository('acme', 'notes', notesFiles())
    const v1 = await env.release(repo.folder)
    const entry = (releases: CatalogueRelease[], ownerId?: number) => ({
      id: 'acme.notes',
      source: { url: repo.url, ref: 'main' },
      ...(ownerId !== undefined ? { ownerId } : {}),
      releases,
    })
    env.serveCatalogue('community', [entry([v1], 7)])
    await env.lifecycle.catalogue.installFrom({ catalogue: 'community', id: 'acme.notes' })
    await approveAll(env)
    env.commit(repo.folder, repo.dir, {
      'extension.json': JSON.stringify(notesManifest({ version: '1.1.0' }), null, 2),
    })
    const v2 = await env.release(repo.folder)
    // The catalogue no longer says, and there are no owner records to ask.
    env.serveCatalogue('community', [entry([v2, v1])])
    await env.lifecycle.catalogue.runUpdates()
    env.advance(AUTO_UPDATE_HOLD_BACK_MS + 1)
    await env.lifecycle.catalogue.runUpdates()
    expect((await env.installed())[0]?.extension.version).toBe('1.0.0')
    expect(env.warnings.join('\n')).toMatch(/cannot read who owns it now/)
    const manual = await env.lifecycle.catalogue.update('acme.notes')
    expect(!manual.ok && manual.message).toMatch(/cannot read who owns acme\.notes now/)

    // The owner records say it is still the same account; they are kept for a restart.
    env.served.set(env.urls.owners, { ownersVersion: 1, owners: [{ login: 'acme', id: 7 }] })
    await env.lifecycle.catalogue.runUpdates()
    expect((await env.installed())[0]?.extension.version).toBe('1.1.0')
    expect(readOwnerRecordsCacheSync(env.dataDir)?.owners).toEqual([{ login: 'acme', id: 7 }])
  })

  test('an install whose owner was not known takes it at the first pass that knows', async () => {
    const env = setup()
    const repo = env.repository('acme', 'notes', notesFiles())
    env.serveCatalogue('community', [
      { id: 'acme.notes', source: { url: repo.url, ref: 'main' }, releases: [await env.release(repo.folder)] },
    ])
    await env.lifecycle.catalogue.installFrom({ catalogue: 'community', id: 'acme.notes' })
    expect(readInstallRecordsSync(env.dataDir)['acme.notes']?.ownerId).toBeUndefined()
    env.served.set(env.urls.owners, { ownersVersion: 1, owners: [{ login: 'acme', id: 7 }] })
    await env.lifecycle.catalogue.runUpdates()
    expect(readInstallRecordsSync(env.dataDir)['acme.notes']?.ownerId).toBe(7)
  })
})

describe('parity', () => {
  test('an extension switched off is not updated on its own', async () => {
    const env = setup()
    const repo = env.repository('acme', 'notes', notesFiles())
    const v1 = await env.release(repo.folder)
    const entry = (releases: CatalogueRelease[]) => ({
      id: 'acme.notes',
      source: { url: repo.url, ref: 'main' },
      releases,
    })
    env.serveCatalogue('community', [entry([v1])])
    await env.lifecycle.catalogue.installFrom({ catalogue: 'community', id: 'acme.notes' })
    await approveAll(env)
    await env.lifecycle.setEnabled('acme.notes', false)
    env.commit(repo.folder, repo.dir, {
      'extension.json': JSON.stringify(notesManifest({ version: '1.1.0' }), null, 2),
    })
    env.serveCatalogue('community', [entry([await env.release(repo.folder), v1])])
    await env.lifecycle.catalogue.runUpdates()
    env.advance(AUTO_UPDATE_HOLD_BACK_MS + 1)
    await env.lifecycle.catalogue.runUpdates()
    expect((await env.installed())[0]?.extension.version).toBe('1.0.0')
  })

  test('the community catalogue can be removed, and added back', async () => {
    const env = setup()
    env.serveCatalogue('community', [])
    expect(await env.lifecycle.catalogue.remove('community')).toEqual({ ok: true })
    expect((await env.lifecycle.catalogue.catalogues()).map((catalogue) => catalogue.id)).toEqual(['official'])
    const entry = await env.lifecycle.catalogue.entry('community', 'acme.notes')
    expect(!entry.ok && entry.message).toMatch(/has not been added/)
    expect(await env.lifecycle.catalogue.add('community')).toMatchObject({ ok: true, catalogue: { id: 'community' } })
    expect((await env.lifecycle.catalogue.catalogues()).map((catalogue) => catalogue.id)).toEqual([
      'official',
      'community',
    ])
  })

  test('a catalogue image is fetched once, and an escaped path is refused', async () => {
    const env = setup()
    const repo = env.repository('acme', 'notes', notesFiles())
    const png = Buffer.from('an image')
    const sha256 = createHash('sha256').update(png).digest('hex')
    env.served.set(`${env.urls.base}/images/notes.png`, png)
    env.serveCatalogue('community', [
      {
        id: 'acme.notes',
        source: { url: repo.url, ref: 'main' },
        releases: [
          {
            ...(await env.release(repo.folder)),
            images: { icon: { path: 'images/notes.png', sha256, alt: 'The notes icon' } },
          },
        ],
      },
    ])
    await env.lifecycle.catalogue.catalogues(true)
    for (let i = 0; i < 3; i += 1) {
      const image = await env.lifecycle.catalogue.image('community', 'images/notes.png', sha256)
      expect(image).toMatchObject({ ok: true, mime: 'image/png' })
    }
    expect(env.imageFetches).toHaveLength(1)
    const escaped = await env.lifecycle.catalogue.image('community', 'images/%2e%2e/notes.png', sha256)
    expect(!escaped.ok && escaped.message).toMatch(/not an image a catalogue may name/)
  })
})

function readdirDeep(dir: string): string[] {
  const out: string[] = []
  const walk = (at: string, prefix: string) => {
    for (const name of existsSync(at) ? readdirSync(at) : []) {
      const path = join(at, name)
      const rel = prefix ? `${prefix}/${name}` : name
      if (statSync(path).isDirectory()) walk(path, rel)
      else out.push(rel)
    }
  }
  walk(dir, '')
  return out
}
