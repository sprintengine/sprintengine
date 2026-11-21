import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, chmod, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { createFileViews, readHighlights } from './file-views'
import { createFileViewTools } from './file-view-tools'
import type { McpConnectionContext } from '../../shared/modules/mcp-tools'

// The files a chat's agent shows the person, read and saved for the person
// through that chat: only a file the chat showed, conditional on the file as
// it was read, and never by the agent.

const CHAT = { workspaceId: 'ws-1', agentId: 'agent-1' }
const OTHER_CHAT = { workspaceId: 'ws-2', agentId: 'agent-1' }
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'file-views-')))
  const home = join(root, 'home')
  const project = join(root, 'project')
  const data = join(root, 'data')
  await mkdir(join(home, '.claude'), { recursive: true })
  await mkdir(join(project, 'src'), { recursive: true })
  await writeFile(join(home, '.claude', 'CLAUDE.md'), '# Rules\n\nBe brief.\n')
  await writeFile(join(project, 'src', 'app.ts'), 'export const a = 1\nexport const b = 2\n')
  const make = () => createFileViews({ dataDir: data, home, folderOf: () => project })
  return { root, home, project, data, views: make(), make }
}

test('a file is shown by its real path, relative to the chat’s folder or the home folder, and nothing is written', async () => {
  const f = await fixture()
  const before = await stat(join(f.home, '.claude', 'CLAUDE.md'))
  const shown = await f.views.show(CHAT, [
    { path: '~/.claude/CLAUDE.md' },
    { path: 'src/app.ts', highlights: [{ from: 2, to: 2, note: 'this one' }] },
  ])
  assert.deepEqual(shown.failed, [])
  assert.deepEqual(
    shown.shown.map((file) => [file.path, file.name, file.lines]),
    [
      [join(f.home, '.claude', 'CLAUDE.md'), 'CLAUDE.md', 4],
      [join(f.project, 'src', 'app.ts'), 'app.ts', 3],
    ],
  )
  assert.deepEqual(shown.shown[1]!.highlights, [{ from: 2, to: 2, note: 'this one' }])
  assert.equal((await stat(join(f.home, '.claude', 'CLAUDE.md'))).mtimeMs, before.mtimeMs, 'showing writes nothing')
  await rm(f.root, { recursive: true, force: true })
})

test('a missing, binary or oversized file is named with why, and the rest are shown', async () => {
  const f = await fixture()
  await writeFile(join(f.project, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]))
  await writeFile(join(f.project, 'big.log'), 'x'.repeat(2 * 1024 * 1024 + 1))
  const shown = await f.views.show(CHAT, [
    { path: 'missing.md' },
    { path: 'logo.png' },
    { path: 'big.log' },
    { path: 'src/app.ts' },
  ])
  assert.equal(shown.shown.length, 1)
  assert.deepEqual(
    shown.failed.map((entry) => entry.path),
    ['missing.md', 'logo.png', 'big.log'],
  )
  assert.match(shown.failed[0]!.reason, /There is no file at/)
  assert.match(shown.failed[1]!.reason, /not text/)
  assert.match(shown.failed[2]!.reason, /up to 2 MB/)
  await rm(f.root, { recursive: true, force: true })
})

test('a save lands on a file the chat showed, conditional on what was read, and keeps its mode', async () => {
  const f = await fixture()
  const path = join(f.home, '.claude', 'CLAUDE.md')
  await chmod(path, 0o640)
  await f.views.show(CHAT, [{ path }])
  const read = await f.views.read(CHAT, path)
  assert.ok(read.ok)
  assert.equal(read.read.hash, sha('# Rules\n\nBe brief.\n'))
  const written = await f.views.write(CHAT, path, '# Rules\n\nBe very brief.\n', read.read.hash)
  assert.ok(written.ok && written.written.ok)
  assert.equal(written.written.hash, sha('# Rules\n\nBe very brief.\n'))
  assert.equal(await readFile(path, 'utf8'), '# Rules\n\nBe very brief.\n')
  assert.equal((await stat(path)).mode & 0o777, 0o640)
  await rm(f.root, { recursive: true, force: true })
})

test('a file changed on disk since it was read is a conflict, and is left as it is', async () => {
  const f = await fixture()
  const path = join(f.project, 'src', 'app.ts')
  await f.views.show(CHAT, [{ path }])
  const read = await f.views.read(CHAT, path)
  assert.ok(read.ok)
  await writeFile(path, 'export const a = 3\n')
  const written = await f.views.write(CHAT, path, 'mine\n', read.read.hash)
  assert.ok(written.ok)
  assert.deepEqual(written.written, { ok: false, code: 'conflict', currentHash: sha('export const a = 3\n') })
  assert.equal(await readFile(path, 'utf8'), 'export const a = 3\n')
  // Gone from disk: a conflict too, with no hash, and nothing made in its place.
  await rm(path)
  const gone = await f.views.write(CHAT, path, 'mine\n', read.read.hash)
  assert.ok(gone.ok)
  assert.deepEqual(gone.written, { ok: false, code: 'conflict', currentHash: null })
  await assert.rejects(stat(path))
  await rm(f.root, { recursive: true, force: true })
})

test('only the chat that showed a file reads or saves it; any other path is not there', async () => {
  const f = await fixture()
  const shown = join(f.project, 'src', 'app.ts')
  const unshown = join(f.home, '.claude', 'CLAUDE.md')
  await f.views.show(CHAT, [{ path: shown }])
  const hash = sha('export const a = 1\nexport const b = 2\n')
  for (const [chat, path] of [
    [OTHER_CHAT, shown],
    [CHAT, unshown],
    [CHAT, `${f.project}/src/../src/app.ts`],
  ] as const) {
    const read = await f.views.read(chat, path)
    assert.equal(read.ok ? null : read.code, 'not_found', `${chat.workspaceId} ${path}`)
    const written = await f.views.write(chat, path, 'x', hash)
    assert.equal(written.ok ? null : written.code, 'not_found')
  }
  assert.equal(await readFile(shown, 'utf8'), 'export const a = 1\nexport const b = 2\n')
  await rm(f.root, { recursive: true, force: true })
})

test('a link put where a shown file was is not that file', async () => {
  const f = await fixture()
  const path = join(f.project, 'src', 'app.ts')
  await f.views.show(CHAT, [{ path }])
  const read = await f.views.read(CHAT, path)
  assert.ok(read.ok)
  await rm(path)
  await symlink(join(f.home, '.claude', 'CLAUDE.md'), path)
  assert.equal((await f.views.read(CHAT, path)).ok, false)
  const written = await f.views.write(CHAT, path, 'x', sha('# Rules\n\nBe brief.\n'))
  assert.equal(written.ok ? null : written.code, 'not_found')
  assert.equal(await readFile(join(f.home, '.claude', 'CLAUDE.md'), 'utf8'), '# Rules\n\nBe brief.\n')
  await rm(f.root, { recursive: true, force: true })
})

test('what a chat showed is remembered across a restart', async () => {
  const f = await fixture()
  const path = join(f.project, 'src', 'app.ts')
  await f.views.show(CHAT, [{ path }])
  const again = f.make()
  assert.equal((await again.read(CHAT, path)).ok, true)
  await rm(f.root, { recursive: true, force: true })
})

test('highlights are read into whole, ordered ranges within the file', () => {
  assert.deepEqual(
    readHighlights(
      [{ from: 9, to: 7, note: '  why  ' }, { from: 2.6 }, { from: 50, to: 80 }, { to: 3 }, 'nonsense'],
      10,
    ),
    [
      { from: 2, to: 2 },
      { from: 7, to: 9, note: 'why' },
      { from: 10, to: 10 },
    ],
  )
})

test('file.view answers the files shown by their real paths, names the rest, and is refused to no agent', async () => {
  const f = await fixture()
  const [tool] = createFileViewTools({ views: f.views })
  const agent: McpConnectionContext = { metadata: { kind: 'studio-agent', ...CHAT } }
  const answer = await tool!.handler({ files: [{ path: 'src/app.ts' }, { path: 'nope.md' }] }, agent)
  const structured = answer.structuredContent as {
    files: Array<{ path: string }>
    notShown: Array<{ path: string }>
  }
  assert.deepEqual(
    structured.files.map((file) => file.path),
    [join(f.project, 'src', 'app.ts')],
  )
  assert.deepEqual(
    structured.notShown.map((file) => file.path),
    ['nope.md'],
  )
  const none = await tool!.handler({ files: [{ path: 'nope.md' }] }, agent)
  assert.equal((none.structuredContent as { error?: { code: string } }).error?.code, 'not_shown')
  const stranger = await tool!.handler({ files: [{ path: 'src/app.ts' }] }, { metadata: { kind: 'external-local' } })
  assert.equal((stranger.structuredContent as { error?: { code: string } }).error?.code, 'not_an_agent')
  const tooMany = await tool!.handler({ files: Array.from({ length: 9 }, () => ({ path: 'src/app.ts' })) }, agent)
  assert.equal((tooMany.structuredContent as { error?: { code: string } }).error?.code, 'invalid_arguments')
  await rm(f.root, { recursive: true, force: true })
})
