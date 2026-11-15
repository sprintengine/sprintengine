// Built-in skills, Studio's own plugin, and the agent CLIs' plugin listing.
// ../electron-api.ts re-exports everything here.

import type { BuiltinSkill, BuiltinSkillTargetState } from '../../../packages/studio-protocol/src/public'

// A built-in skill and what it would install, as the Studio protocol carries them (`builtinSkills.*`).
export type {
  BuiltinSkill,
  BuiltinSkillStatus,
  BuiltinSkillTargetState,
} from '../../../packages/studio-protocol/src/public'

export type { PluginRegistryListResult, StudioPluginStatus } from '../../../packages/studio-protocol/src/public'

export type BuiltinSkillInstallResult =
  | {
      ok: true
      status: 'installed' | 'updated'
      skill: BuiltinSkill
      destinationPath: string
      skipped?: BuiltinSkillTargetState[]
    }
  | {
      ok: false
      status: 'unknown-skill' | 'missing-workspace' | 'missing-source' | 'modified' | 'local'
      skillId: string
      message: string
    }
