import { skillFolderIssues } from '../../../../packages/extension-sdk/src/skill-folders'
import type { ExtensionManifest } from '../../../shared/modules/third-party-manifest'

type Issue = { path: string; message: string }

/**
 * What an extension hands agents, checked at install the way the projection
 * will use it, so an author hears about a skill folder with no SKILL.md, or a
 * provider that takes a built-in's id, before anything is copied. The skill
 * folder checks are the SDK's (skill-folders.ts), which
 * `sprintengine-extension validate` runs too.
 */
export async function agentContributionIssues(
  extension: Pick<ExtensionManifest, 'contributes'>,
  folder: string,
  protectedProviderIds: ReadonlySet<string> = new Set(),
): Promise<Issue[]> {
  const issues: Issue[] = skillFolderIssues(extension, folder)
  for (const [index, provider] of extension.contributes.providers.entries())
    if (protectedProviderIds.has(provider.id))
      issues.push({
        path: `contributes.providers[${index}].id`,
        message: `"${provider.id}" is the id of one of Studio’s own providers or agents; choose another.`,
      })
  return issues
}
