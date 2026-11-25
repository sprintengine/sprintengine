// The glyphs a components panel names (`icon` props), drawn with the app's own
// glyphs. A name the app has no glyph for, or one outside the catalogue's
// list, draws the neutral extension mark.

import type { ComponentType, JSX } from 'react'

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
} from '../../AppIcons'
import { ComposerPlusGlyph } from '../../ui/ComposerGlyphs'
import { DeleteChangelistGlyph, EditChangelistGlyph } from '../../ui/GitActionGlyphs'
import { KebabGlyph } from '../../ui/KebabGlyph'
import { OpenInWindowGlyph } from '../../ui/OpenInWindowGlyph'
import { RefreshIcon } from '../../ui/RefreshIcon'
import { PlayGlyph } from '../../ui/TourGlyphs'
import { TerminalAgentGlyph } from '../../ui/ComposerGlyphs'
import { FileTypeGlyph } from '../../ui/FileTypeGlyph'
import { TerminalGlyph } from '../../workspace/pane/paneKinds'
import { StopGlyph } from '../../panels/agentChat/stopGlyph'

type Glyph = ComponentType<{ className?: string }>

const GLYPHS: Record<string, Glyph> = {
  add: ComposerPlusGlyph,
  delete: DeleteChangelistGlyph,
  edit: EditChangelistGlyph,
  refresh: RefreshIcon,
  settings: GeneralSettingsIcon,
  check: CheckIcon,
  warning: WarningIcon,
  error: WarningIcon,
  'open-external': OpenInWindowGlyph,
  copy: CopyIcon,
  play: PlayGlyph,
  stop: StopGlyph,
  more: KebabGlyph,
  branch: GitBranchGlyph,
  // One file, as the Files tree draws a file of no known type (not the Files tab's folder).
  file: GenericFileGlyph,
  folder: ProjectFolderGlyph,
  terminal: TerminalGlyph,
  agent: TerminalAgentGlyph,
  extension: ExtensionsGlyph,
  chat: ChatGlyph,
  schedule: ScheduleGlyph,
  spark: SparkGlyph,
  lock: LockGlyph,
  notes: ReleaseNotesIcon,
}

function GenericFileGlyph({ className }: { className?: string }): JSX.Element {
  return <FileTypeGlyph kind="generic" {...(className ? { className } : {})} />
}

/** The glyph for an icon name; the neutral mark for one the app does not draw. */
export function ComponentIcon({ name, className = 'icon-sm' }: { name: string; className?: string }): JSX.Element {
  const Glyph = (Object.hasOwn(GLYPHS, name) ? GLYPHS[name] : undefined) ?? ExtensionsGlyph
  return (
    <span aria-hidden="true" className="inline-flex shrink-0 items-center" data-component-icon={name}>
      <Glyph className={className} />
    </span>
  )
}
