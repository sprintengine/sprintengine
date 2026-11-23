import { execFileSync } from 'node:child_process'
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
import { readInstallRecordsSync } from './catalogue-files'
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
  let clock = Date.parse('2026-11-20T00:00:00Z')
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
    await env.lifecycle.uninstall('acme.notes')

    env.commit(repo.folder, repo.dir, { 'skills/notes/SKILL.md': `${SKILL}\nSwapped.\n` })
    const moved = await env.release(repo.folder)
    expect(moved.version).toBe(first.version)
    env.serveCatalogue('community', [{ id: 'acme.notes', source: { url: repo.url, ref: 'main' }, releases: [moved] }])
    const answer = await env.lifecycle.catalogue.installFrom({ catalogue: 'community', id: 'acme.notes' })
    expect(!answer.ok && answer.message).toMatch(/a listed version never moves/)
  })
})

describe('installing from a git URL', () => {
  test('a moved tag never replaces a version Studio has seen', async () => {
    const env = setup()
    const repo = env.repository('acme', 'notes', notesFiles())
    git(repo.dir, 'tag', 'v1.0.0')
    const first = await env.lifecycle.catalogue.installFrom({ git: repo.url, ref: 'v1.0.0' })
    expect(first).toMatchObject({ ok: true, moduleId: 'acme.notes' })
    const [view] = await env.installed()
    expect(view?.origin?.label).toBe('Unverified')
    await env.lifecycle.uninstall('acme.notes')

    env.commit(repo.folder, repo.dir, { 'skills/notes/SKILL.md': `${SKILL}\nNot the same bytes.\n` })
    git(repo.dir, 'tag', '--force', 'v1.0.0')
    const again = await env.lifecycle.catalogue.installFrom({ git: repo.url, ref: 'v1.0.0' })
    expect(!again.ok && again.message).toMatch(/a listed version never moves/)
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
