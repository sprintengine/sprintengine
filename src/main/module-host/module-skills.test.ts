import assert from 'node:assert/strict'

import type { EnsureSkillInstalledResult, ModuleSkillStatusResult } from '../../shared/modules/skills'
import { loadMainModules, type CapabilityModule } from './load-modules'
import { createMainKernel, type ModuleSkillHostRegistry } from './main-host'
import { test } from 'vitest'

// The host half of skills a module asks for: `ensureSkillInstalled` and
// `getSkillStatus` hand the skill registry the workspace and the skill id, and
// answer what it answers. The install mechanics live one layer down
// (src/main/builtin-skills.ts) and are covered there; a recording registry
// keeps the host contract testable without a filesystem.

const KNOWN_SKILLS = new Set(['studio-review'])

function createRecordingSkillRegistry(): {
  registry: ModuleSkillHostRegistry
  ensured: Array<{ workspaceRoot: string; skillId: string }>
  checked: Array<{ workspaceRoot: string; skillId: string }>
} {
  const ensured: Array<{ workspaceRoot: string; skillId: string }> = []
  const checked: Array<{ workspaceRoot: string; skillId: string }> = []
  const unknown = (skillId: string) =>
    ({ ok: false, status: 'unknown-skill', message: `Unknown skill: ${skillId}` }) as const
  const registry: ModuleSkillHostRegistry = {
    async ensureInstalled(workspaceRoot, skillId): Promise<EnsureSkillInstalledResult> {
      ensured.push({ workspaceRoot, skillId })
      return KNOWN_SKILLS.has(skillId) ? { ok: true, status: 'installed' } : unknown(skillId)
    },
    async getStatus(workspaceRoot, skillId): Promise<ModuleSkillStatusResult> {
      checked.push({ workspaceRoot, skillId })
      return KNOWN_SKILLS.has(skillId) ? { ok: false, status: 'missing' } : unknown(skillId)
    },
  }
  return { registry, ensured, checked }
}

test('ensureSkillInstalled delegates to the skill registry and reports unknown ids', async () => {
  const recorder = createRecordingSkillRegistry()
  const host = createMainKernel({ skillRegistry: recorder.registry }).hostFor('review')

  assert.deepEqual(await host.ensureSkillInstalled('/Users/dev/project', 'studio-review'), {
    ok: true,
    status: 'installed',
  })
  assert.deepEqual(
    await host.ensureSkillInstalled('/Users/dev/project', 'never-heard-of-it'),
    { ok: false, status: 'unknown-skill', message: 'Unknown skill: never-heard-of-it' },
    'an unknown id answers loudly rather than resolving to nothing',
  )
  assert.deepEqual(recorder.ensured, [
    { workspaceRoot: '/Users/dev/project', skillId: 'studio-review' },
    { workspaceRoot: '/Users/dev/project', skillId: 'never-heard-of-it' },
  ])
  assert.deepEqual(recorder.checked, [], 'installing is not a status check')
})

test('getSkillStatus reads the status and installs nothing', async () => {
  const recorder = createRecordingSkillRegistry()
  const host = createMainKernel({ skillRegistry: recorder.registry }).hostFor('review')

  assert.deepEqual(await host.getSkillStatus('/Users/dev/project', 'studio-review'), { ok: false, status: 'missing' })
  assert.deepEqual(await host.getSkillStatus('/Users/dev/project', 'nope'), {
    ok: false,
    status: 'unknown-skill',
    message: 'Unknown skill: nope',
  })
  assert.deepEqual(recorder.checked, [
    { workspaceRoot: '/Users/dev/project', skillId: 'studio-review' },
    { workspaceRoot: '/Users/dev/project', skillId: 'nope' },
  ])
  assert.deepEqual(recorder.ensured, [])
})

test('loadMainModules hands its modules the skill registry it is given', async () => {
  const recorder = createRecordingSkillRegistry()
  const answers: EnsureSkillInstalledResult[] = []
  const modules: CapabilityModule[] = [
    {
      manifest: { id: 'review', displayName: 'Reviews', version: 1, defaultEnabled: true },
      registerMain: async (host) => {
        answers.push(await host.ensureSkillInstalled('/Users/dev/project', 'studio-review'))
      },
    },
  ]

  const { report, ready } = loadMainModules({ modules, skillRegistry: recorder.registry })
  await ready

  assert.deepEqual(report.errors, [])
  assert.deepEqual(answers, [{ ok: true, status: 'installed' }])
  assert.deepEqual(recorder.ensured, [{ workspaceRoot: '/Users/dev/project', skillId: 'studio-review' }])
})
