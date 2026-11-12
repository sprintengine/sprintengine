// Part of the IPC contract: built-in skills, the studio plugin, and the plugin registry listing.
// ../electron-api.ts re-exports everything here.

import type { PluginRegistryListEntry } from '../plugin-manifest'
import type { BuiltinSkill, BuiltinSkillTargetState } from '../../../packages/studio-protocol/src/public'

// A built-in skill and what it would install, as the Studio protocol carries them (`builtinSkills.*`).
export type {
  BuiltinSkill,
  BuiltinSkillStatus,
  BuiltinSkillTargetState,
} from '../../../packages/studio-protocol/src/public'

/**
 * What the catalogue's built-in row for the app's own plugin reads.
 * `installedVersion` is '' until this app run has installed into that
 * workspace; a value that differs from `bundledVersion` is the drift Sync
 * reports, and the next open closes it.
 */
export type StudioPluginStatus = {
  bundledVersion: string
  installedVersion: string
  skillDirNames: string[]
  claudePluginKey: string
  /** ISO timestamp the hooks acknowledgement was answered, '' when it has not been. */
  hooksAcknowledgedAt: string
}

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

export type PluginRegistryListResult = { ok: true; plugins: PluginRegistryListEntry[] } | { ok: false; message: string }
