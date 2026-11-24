import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, test } from 'vitest'

import {
  BUILTIN_SKILLS,
  createBuiltinSkillManager,
  ensureSkillInstalled,
  getSkillStatus,
  setDefaultSkillManager,
} from './builtin-skills'

// `getSkillStatus` is the read half of `ensureSkillInstalled`: the same
// targets and vocabulary, and nothing written. A module's door asks it to show
// "installed in this project" before the person clicks Install. The bundled
// backlog skill stands in for any skill here.

let temp = ''
let workspaceRoot = ''
let bundledRoot = ''
const SKILL = 'backlog'

async function writeSkillSource(root: string, skillId: string, body: string): Promise<void> {
  await mkdir(join(root, skillId), { recursive: true })
  await writeFile(join(root, skillId, 'SKILL.md'), body, 'utf-8')
}

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'sprintengine-skill-status-'))
  workspaceRoot = join(temp, 'workspace')
  await mkdir(workspaceRoot, { recursive: true })
  bundledRoot = join(temp, 'bundled')
  for (const skill of BUILTIN_SKILLS) await writeSkillSource(bundledRoot, skill.id, 'version one\n')
  setDefaultSkillManager(createBuiltinSkillManager({ sourceRoot: bundledRoot, listPlugins: () => [] }))
})

afterEach(() => {
  setDefaultSkillManager(null)
})

test('an unknown skill answers unknown-skill', async () => {
  assert.deepEqual(await getSkillStatus(workspaceRoot, 'nobody-knows-this'), {
    ok: false,
    status: 'unknown-skill',
    message: 'Unknown skill: nobody-knows-this',
  })
})

test('a skill not yet in the workspace is missing, and asking writes nothing', async () => {
  assert.deepEqual(await getSkillStatus(workspaceRoot, SKILL), { ok: false, status: 'missing' })
  assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', SKILL)), false)
})

test('after ensureSkillInstalled the status reads installed', async () => {
  assert.deepEqual(await ensureSkillInstalled(workspaceRoot, SKILL), { ok: true, status: 'installed' })
  assert.deepEqual(await getSkillStatus(workspaceRoot, SKILL), { ok: true, status: 'installed' })
})

test('a changed source reads update-available until ensure runs again', async () => {
  await ensureSkillInstalled(workspaceRoot, SKILL)
  await writeSkillSource(bundledRoot, SKILL, 'version two\n')
  assert.deepEqual(await getSkillStatus(workspaceRoot, SKILL), { ok: true, status: 'update-available' })
  assert.deepEqual(await ensureSkillInstalled(workspaceRoot, SKILL), { ok: true, status: 'updated' })
  assert.deepEqual(await getSkillStatus(workspaceRoot, SKILL), { ok: true, status: 'installed' })
})

test('a hand-made copy in the way reads local', async () => {
  await writeSkillSource(join(workspaceRoot, '.agents', 'skills'), SKILL, 'mine\n')
  const status = await getSkillStatus(workspaceRoot, SKILL)
  assert.equal(status.ok, true)
  assert.equal(status.status, 'local')
})
