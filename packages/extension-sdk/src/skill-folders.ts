// The skill folders an extension hands agents (`contributes.skills`), checked
// as Studio checks them when it installs or loads an extension: each is a
// folder in the extension holding a SKILL.md, within the size and file-count
// limits. One check, shared by Studio and `sprintengine-extension validate`,
// so a folder the CLI passes is one Studio loads.

import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { SKILL_FILE_MAX_BYTES, SKILL_FOLDER_MAX_FILES, type ExtensionManifest } from './extension-manifest.js'

/** One thing wrong with a skill folder, at the manifest field that names it. */
export type SkillFolderIssue = { path: string; message: string }

/** What is wrong with each skill folder `extension` names under `folder`; empty when nothing is. */
export function skillFolderIssues(
  extension: Pick<ExtensionManifest, 'contributes'>,
  folder: string,
): SkillFolderIssue[] {
  const issues: SkillFolderIssue[] = []
  for (const [index, skill] of extension.contributes.skills.entries()) {
    const path = `contributes.skills[${index}].path`
    const dir = join(folder, ...skill.path.split('/'))
    if (!lstatOrNull(dir)?.isDirectory()) {
      issues.push({ path, message: `is not a folder in the extension: ${skill.path}.` })
      continue
    }
    const file = lstatOrNull(join(dir, 'SKILL.md'))
    if (!file?.isFile()) issues.push({ path, message: `holds no SKILL.md: ${skill.path}.` })
    else if (file.size > SKILL_FILE_MAX_BYTES)
      issues.push({ path, message: `has a SKILL.md over ${SKILL_FILE_MAX_BYTES / 1024} KiB.` })
    if (countFiles(dir, SKILL_FOLDER_MAX_FILES + 1) > SKILL_FOLDER_MAX_FILES)
      issues.push({ path, message: `holds more than ${SKILL_FOLDER_MAX_FILES} files.` })
  }
  return issues
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function countFiles(dir: string, limit: number): number {
  let count = 0
  const pending = [dir]
  while (pending.length > 0 && count < limit) {
    const current = pending.pop()!
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) pending.push(join(current, entry.name))
      else if (entry.isFile()) count += 1
    }
  }
  return count
}
