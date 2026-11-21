import type { ComponentType } from 'react'

import type { ExtensionIcon } from '../../../shared/modules/third-party-manifest'
import {
  ChatGlyph,
  CheckIcon,
  CopyIcon,
  ExtensionsGlyph,
  GeneralSettingsIcon,
  GitBranchGlyph,
  LockGlyph,
  ProjectFolderGlyph,
  ReleaseNotesIcon,
  ScheduleGlyph,
  SparkGlyph,
  WarningIcon,
} from '../components/AppIcons'

// The glyph each icon name in extension.json draws: the app's own, so an
// extension's door, tab and button sit among the built-in ones in the same
// hand. The vocabulary is closed (EXTENSION_ICONS in the SDK); a name added
// there needs a glyph here, which the Record type holds it to.
const GLYPHS: Record<ExtensionIcon, ComponentType<{ className?: string }>> = {
  extension: ExtensionsGlyph,
  chat: ChatGlyph,
  branch: GitBranchGlyph,
  folder: ProjectFolderGlyph,
  schedule: ScheduleGlyph,
  spark: SparkGlyph,
  lock: LockGlyph,
  settings: GeneralSettingsIcon,
  check: CheckIcon,
  warning: WarningIcon,
  copy: CopyIcon,
  notes: ReleaseNotesIcon,
}

export function extensionGlyph(icon: ExtensionIcon | string | undefined): ComponentType<{ className?: string }> {
  return (icon && GLYPHS[icon as ExtensionIcon]) || ExtensionsGlyph
}
