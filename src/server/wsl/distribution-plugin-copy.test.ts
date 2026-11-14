// The app's Claude plugin copy as a WSL distribution's Studio builds it for the
// desktop's WSL terminals, from its own resources: every path in it is this
// server's own, every hook runs this server's Node, and the tree is written
// whole and replaced atomically.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import { hasUnsubstitutedTokens } from '../../main/skills/studio-plugin'
import { buildPluginCopy, createDistributionPluginCopies, pinHookNode } from './distribution-plugin-copy'
import { checkTreePath, ensureTree } from './distribution/files.mjs'

const NODE = '/home/dev/.local/share/sprintengine-studio/runtime/node-v24.21.0/bin/node'
const RESOURCES = join(process.cwd(), 'resources')
const SOCKET = '/run/user/1000/sprintengine/abc123def456/agent.sock'

let temp = ''
beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), 'se-plugin-copy-'))
})
afterAll(() => rmSync(temp, { recursive: true, force: true }))

const sources = (enabledSkillDirs: string[] = []) => ({
  templateRoot: join(RESOURCES, 'studio-plugin'),
  reporterSourcePath: join(RESOURCES, 'hooks', 'sprintengine-agent-state.mjs'),
  statusLineSourcePath: join(RESOURCES, 'hooks', 'sprintengine-status-line.mjs'),
  enabledSkillDirs,
  launchSkillsSourceRoot: join(RESOURCES, 'builtin-skills'),
})

test('hook commands run the pinned Node, not whatever node is on PATH', () => {
  const pinned = pinHookNode(
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "/a/b.mjs" --socket "/s"' }] }] } }),
    NODE,
  )
  const parsed = JSON.parse(pinned) as { hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> } }
  assert.equal(parsed.hooks.Stop[0].hooks[0].command, `'${NODE}' "/a/b.mjs" --socket "/s"`)
  assert.equal(pinHookNode('not json', NODE), 'not json')
})

test("the copy names this server's paths throughout, and the same inputs give the same digest", async () => {
  const dataDir = '/home/dev/.local/share/sprintengine-studio/profiles/abc123def456'
  const resourcesDir = '/home/dev/.local/share/sprintengine-studio/server-0.4.0/resources'
  const tokens = { nodeCommand: NODE, resourcesDir, dataDir, agentStateSocketPath: SOCKET }
  const copy = await buildPluginCopy(sources(), tokens)
  assert.ok(copy)
  const root = `${dataDir}/terminal-plugin`
  assert.deepEqual(copy.pluginDirs, [`${root}/sprintengine-studio`])
  assert.equal(copy.statusLineScriptPath, `${root}/sprintengine-studio/hooks/status-line.mjs`)
  const text = (path: string) =>
    Buffer.from(copy.files.find((file) => file.path === path)?.b64 ?? '', 'base64').toString('utf8')
  const mcp = JSON.parse(text('sprintengine-studio/.mcp.json')) as {
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>
  }
  const gateway = Object.values(mcp.mcpServers)[0]
  assert.equal(gateway.command, NODE)
  assert.deepEqual(gateway.args, [`${resourcesDir}/automation/mcp-stdio-bridge.mjs`])
  // The bridge finds this server's gateway by its data directory.
  assert.equal(gateway.env.SPRINTENGINE_USER_DATA_DIR, dataDir)
  const hooks = text('sprintengine-studio/hooks/hooks.json')
  assert.ok(hooks.includes(`'${NODE}' \\"${root}/sprintengine-studio/hooks/agent-state.mjs\\"`), hooks)
  assert.ok(hooks.includes(SOCKET))
  assert.ok(!/node \\"/u.test(hooks), 'no hook runs a bare node')
  for (const file of copy.files) {
    const content = Buffer.from(file.b64, 'base64').toString('utf8')
    assert.equal(hasUnsubstitutedTokens(content), false, file.path)
    assert.doesNotMatch(content, /[A-Z]:[\\/]Users|\\\\wsl/u, `${file.path} names no Windows path`)
  }
  assert.ok(copy.files.some((file) => file.path === 'sprintengine-studio/hooks/agent-state.mjs'))
  assert.equal((await buildPluginCopy(sources(), tokens))?.digest, copy.digest)
  assert.equal(await buildPluginCopy({ ...sources(), templateRoot: join(temp, 'none') }, tokens), null)
  assert.equal(await buildPluginCopy({ ...sources(), reporterSourcePath: join(temp, 'none.mjs') }, tokens), null)

  // The Studio skills are the person's choice: the copy carries only those, and
  // a different choice is a different digest, so the tree is written again.
  const skillsIn = (files: { path: string }[]) =>
    [
      ...new Set(
        files
          .map((file) => /^sprintengine-studio\/skills\/([^/]+)\//u.exec(file.path)?.[1])
          .filter((name): name is string => name !== undefined),
      ),
    ].sort()
  assert.deepEqual(skillsIn(copy.files), [], 'nothing chosen, no skill')
  const chosen = await buildPluginCopy(sources(['studio-canvas']), tokens)
  assert.ok(chosen)
  assert.deepEqual(skillsIn(chosen.files), ['studio-canvas'])
  assert.notEqual(chosen.digest, copy.digest)

  // The bundled skills a launch can ask for travel as plugins of their own,
  // named by their paths in the distribution, and none is passed to every launch.
  assert.deepEqual(copy.skillPluginDirs, { backlog: `${root}/launch-skills/backlog` })
  assert.ok(copy.files.some((file) => file.path === 'launch-skills/backlog/skills/backlog/SKILL.md'))
  assert.ok(copy.files.some((file) => file.path === 'launch-skills/backlog/.claude-plugin/plugin.json'))
  assert.equal(
    copy.files.some((file) => file.path.startsWith('launch-skills/debug/')),
    false,
  )
  assert.equal(copy.pluginDirs.length, 1)
})

test('the server writes the copy under its data directory, and rewrites it only when the skills change', async () => {
  const dataDir = join(temp, 'data')
  mkdirSync(dataDir, { recursive: true })
  const copies = createDistributionPluginCopies({
    resourcesDir: RESOURCES,
    dataDir,
    agentStateSocketPath: SOCKET,
    nodeCommand: NODE,
  })
  const root = join(dataDir, 'terminal-plugin')
  const first = await copies.ensure([])
  assert.deepEqual(first.pluginDirs, [`${root}/sprintengine-studio`])
  const marker = readFileSync(join(root, '.ready'), 'utf8')
  assert.ok(statSync(join(root, 'sprintengine-studio', 'hooks', 'agent-state.mjs')).isFile())
  assert.equal(statSync(join(root, 'sprintengine-studio', '.mcp.json')).mode & 0o077, 0, 'private to this user')
  // Asked at once, twice: one after the other, never two writers.
  const [again] = await Promise.all([copies.ensure([]), copies.ensure([])])
  assert.deepEqual(again, first)
  assert.equal(readFileSync(join(root, '.ready'), 'utf8'), marker)
  await copies.ensure(['studio-canvas'])
  assert.notEqual(readFileSync(join(root, '.ready'), 'utf8'), marker)
  assert.ok(statSync(join(root, 'sprintengine-studio', 'skills', 'studio-canvas')).isDirectory())
  // Nothing is left beside it.
  assert.deepEqual(readdirSync(dataDir), ['terminal-plugin'])

  // A tree with no resources makes no copy: the workspace install carries agent state.
  const none = createDistributionPluginCopies({ resourcesDir: null, dataDir, agentStateSocketPath: SOCKET })
  assert.deepEqual(await none.ensure([]), { pluginDirs: [], skillPluginDirs: {}, statusLineScriptPath: null })
})

test('a tree lands whole with its marker, is skipped when current, and refuses a path that leaves it', () => {
  const base = join(temp, 'trees')
  mkdirSync(base, { recursive: true })
  const digest = 'a'.repeat(64)
  const tree = [
    { path: 'sprintengine-studio/hooks/hooks.json', b64: Buffer.from('{"hooks":{}}').toString('base64') },
    { path: 'studio-skills/skills/x/SKILL.md', b64: Buffer.from('# x').toString('base64') },
  ]
  assert.deepEqual(ensureTree({ base, name: 'plugin', digest }), { root: join(base, 'plugin'), current: false })
  assert.equal(ensureTree({ base, name: 'plugin', digest, files: tree }).current, true)
  assert.equal(readFileSync(join(base, 'plugin', 'studio-skills/skills/x/SKILL.md'), 'utf8'), '# x')
  assert.equal(readFileSync(join(base, 'plugin', '.ready'), 'utf8'), digest)
  assert.equal(statSync(join(base, 'plugin', 'sprintengine-studio/hooks/hooks.json')).mode & 0o077, 0)
  assert.equal(ensureTree({ base, name: 'plugin', digest }).current, true)
  // A new digest replaces the tree wholesale.
  ensureTree({ base, name: 'plugin', digest: 'b'.repeat(64), files: [tree[0]] })
  assert.throws(() => statSync(join(base, 'plugin', 'studio-skills')))
  for (const bad of ['../x', '/etc/passwd', 'a/../../x', 'a\\b', '', 'a//b']) {
    assert.equal(checkTreePath(bad), false, bad)
    assert.throws(() => ensureTree({ base, name: 'plugin', digest: 'c'.repeat(64), files: [{ path: bad, b64: '' }] }))
  }
  assert.throws(() => ensureTree({ base, name: '../up', digest }), /plain token/u)
})
