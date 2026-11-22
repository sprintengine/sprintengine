import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { SKILL_FILE_MAX_BYTES, SKILL_FOLDER_MAX_FILES } from '../../../../packages/extension-sdk/src/extension-manifest'
import type { ExtensionManifest } from '../../../shared/modules/third-party-manifest'

type Issue = { path: string; message: string }

/**
 * What an extension hands agents, checked at install the way the projection
 * will use it, so an author hears about a skill folder with no SKILL.md, or a
 * provider that takes a built-in's id, before anything is copied.
 */
export async function agentContributionIssues(
  extension: Pick<ExtensionManifest, 'contributes'>,
  folder: string,
  protectedProviderIds: ReadonlySet<string> = new Set(),
): Promise<Issue[]> {
  const issues: Issue[] = []
  for (const [index, skill] of extension.contributes.skills.entries()) {
    const path = `contributes.skills[${index}].path`
    const dir = join(folder, ...skill.path.split('/'))
    const info = await lstat(dir).catch(() => null)
    if (!info?.isDirectory()) {
      issues.push({ path, message: `is not a folder in the extension: ${skill.path}.` })
      continue
    }
    const file = await lstat(join(dir, 'SKILL.md')).catch(() => null)
    if (!file?.isFile()) issues.push({ path, message: `holds no SKILL.md: ${skill.path}.` })
    else if (file.size > SKILL_FILE_MAX_BYTES)
      issues.push({ path, message: `has a SKILL.md over ${SKILL_FILE_MAX_BYTES / 1024} KiB.` })
    const count = await countFiles(dir, SKILL_FOLDER_MAX_FILES + 1)
    if (count > SKILL_FOLDER_MAX_FILES)
      issues.push({ path, message: `holds more than ${SKILL_FOLDER_MAX_FILES} files.` })
  }
  for (const [index, provider] of extension.contributes.providers.entries())
    if (protectedProviderIds.has(provider.id))
      issues.push({
        path: `contributes.providers[${index}].id`,
        message: `"${provider.id}" is the id of one of Studio’s own providers or agents; choose another.`,
      })
  return issues
}

async function countFiles(dir: string, limit: number): Promise<number> {
  let count = 0
  const pending = [dir]
  while (pending.length > 0 && count < limit) {
    const current = pending.pop()!
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) pending.push(join(current, entry.name))
      else if (entry.isFile()) count += 1
    }
  }
  return count
}
