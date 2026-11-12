import type {
  SkillSource,
  StudioAgentSkillsMethod,
  StudioAgentSkillsMethodMap,
  StudioGrant,
  StudioHandlerOf,
} from '../../../packages/studio-protocol/src/public'
import { isMachinePath } from '../../shared/machine-paths'
import { LOCAL_SKILL_SOURCE_ID_PREFIX } from '../../shared/skills'
import type { StudioAgentSkills } from '../core/studio-agent-skills'
import type { StudioRequestContext } from './studio-rpc-types'

// The router's answers to `agent-skills` (`skillSources.*`, `skills.*`,
// `skillPlugins.*`, `workspaceSkills.list`, `installedSkills.*`,
// `agentCapabilities.resolve`, `agentSkills.attach`, `designSystem.*` and
// `cards.run`): each method's domain call, once the router has held the grant
// to the method's scope and refused an owner's method to anyone else.
//
// The rule of their own: every folder a client that is not an owner names is
// held to the folders the Studio knows, on the path it resolves to (the
// router's `mayName`, which follows links): a workspace, a local source, a
// bundle, where a new bundle goes and what it is seeded from, a card's
// workspace, and the folder an id stands for: a library entry's registered
// folder (an attach or a forget), a local source's own (anything naming the
// source). A listing (the library, the sources) shows such a client only the
// entries it could name. A folder on an SSH machine is answered in words until
// that machine's own server serves it.

type Asking = { grant: StudioGrant; context: StudioRequestContext }

export type StudioAgentSkillsHandlers = {
  readonly [M in StudioAgentSkillsMethod]: StudioHandlerOf<StudioAgentSkillsMethodMap[M], Asking>
}

export type StudioAgentSkillsHandlerOptions = {
  /** The domain; without it, every method is answered `unavailable`. */
  skills?: StudioAgentSkills
  /** Whether the asker may name this folder: any, for an owner's own connection; else one Studio knows. */
  mayName(path: string, asking: Asking): Promise<boolean>
}

const UNKNOWN_FOLDER = 'That folder is not one Studio knows.'

/** The folder a source stands for: a local source's (its id is the prefix and the path); none for a repository. */
function sourceFolder(sourceId: string): string | null {
  return sourceId.startsWith(LOCAL_SKILL_SOURCE_ID_PREFIX) ? sourceId.slice(LOCAL_SKILL_SOURCE_ID_PREFIX.length) : null
}

type Refused<C extends 'unavailable' | 'not_found'> = { ok: false; error: { code: C; message: string } }

const refuse = <C extends 'unavailable' | 'not_found'>(code: C, message: string): Refused<C> => ({
  ok: false,
  error: { code, message },
})

function ok<T>(result: T): { ok: true; result: T } {
  return { ok: true, result }
}

export function createStudioAgentSkillsHandlers(options: StudioAgentSkillsHandlerOptions): StudioAgentSkillsHandlers {
  const { skills } = options

  /**
   * Answer from the domain once every folder named (null for none, or the
   * home folder's) is one the asker may name, or say why not.
   */
  async function at<T>(
    method: StudioAgentSkillsMethod,
    folders: ReadonlyArray<string | null | undefined>,
    asking: Asking,
    answer: (domain: StudioAgentSkills) => Promise<T> | T,
  ): Promise<{ ok: true; result: T } | Refused<'unavailable' | 'not_found'>> {
    if (!skills) return refuse('unavailable', `This Studio does not serve ${method}.`)
    for (const folder of folders) {
      if (folder === null || folder === undefined) continue
      if (isMachinePath(folder))
        return refuse('unavailable', `Not available for SSH machines yet (Studio's ${method}).`)
      if (!(await options.mayName(folder, asking))) return refuse('not_found', UNKNOWN_FOLDER)
    }
    return ok(await answer(skills))
  }

  /** Answer from the domain, for a method that names no folder. */
  async function served<T>(
    method: StudioAgentSkillsMethod,
    answer: (domain: StudioAgentSkills) => Promise<T> | T,
  ): Promise<{ ok: true; result: T } | Refused<'unavailable'>> {
    if (!skills) return refuse('unavailable', `This Studio does not serve ${method}.`)
    return ok(await answer(skills))
  }

  /** The entries of a listing the asker may see: those whose folder it may name. */
  async function visible<E extends { path: string }>(entries: readonly E[], asking: Asking): Promise<E[]> {
    const shown: E[] = []
    for (const entry of entries) if (await options.mayName(entry.path, asking)) shown.push(entry)
    return shown
  }

  /** The folder a library entry was registered at, or undefined for an id the library does not hold. */
  async function libraryFolder(domain: StudioAgentSkills, id: string): Promise<string | undefined> {
    return (await domain.designSystem.library()).entries.find((candidate) => candidate.id === id)?.path
  }

  return {
    'skillSources.list': (_params, asking) =>
      served('skillSources.list', async (d) => {
        const listed = await d.skills.listSources()
        if (!listed.ok) return listed
        const sources: SkillSource[] = []
        for (const source of listed.sources) {
          const folder = sourceFolder(source.id)
          if (folder === null || (await options.mayName(folder, asking))) sources.push(source)
        }
        return { ...listed, sources }
      }),
    'skillSources.checkUpdates': () => served('skillSources.checkUpdates', (d) => d.skills.checkSourceUpdates()),
    'skillSources.add': ({ commandId: _commandId, ...input }) =>
      served('skillSources.add', (d) => d.skills.addSource(input)),
    'skillSources.addLocal': ({ folder, replace }, asking) =>
      at('skillSources.addLocal', [folder], asking, (d) =>
        d.skills.addLocalSource({ path: folder, ...(replace ? { replace } : {}) }),
      ),
    'skillSources.remove': ({ sourceId }, asking) =>
      at('skillSources.remove', [sourceFolder(sourceId)], asking, (d) => d.skills.removeSource({ sourceId })),
    'skillSources.sync': ({ sourceId, workspaceFolder, mcpServers }, asking) =>
      at('skillSources.sync', [sourceFolder(sourceId), workspaceFolder], asking, (d) =>
        d.skills.syncSource({ sourceId, workspaceRoot: workspaceFolder, ...(mcpServers ? { mcpServers } : {}) }),
      ),
    'skills.scan': (input, asking) =>
      at('skills.scan', [sourceFolder(input.sourceId)], asking, (d) => d.skills.getScan(input)),
    'skills.readFile': (input, asking) =>
      at('skills.readFile', [sourceFolder(input.sourceId)], asking, (d) => d.skills.readFile(input)),
    'skills.install': ({ sourceId, skillId, workspaceFolder, scope }, asking) =>
      at('skills.install', [sourceFolder(sourceId), workspaceFolder], asking, (d) =>
        d.skills.install({
          sourceId,
          skillId,
          ...(workspaceFolder === undefined ? {} : { workspaceRoot: workspaceFolder }),
          ...(scope ? { scope } : {}),
        }),
      ),
    'skills.uninstall': ({ workspaceFolder, dirName }, asking) =>
      at('skills.uninstall', [workspaceFolder], asking, (d) =>
        d.skills.uninstall({ workspaceRoot: workspaceFolder, dirName }),
      ),
    'skills.search': (input) => served('skills.search', (d) => d.skills.search(input)),
    'skills.popularRepos': () => served('skills.popularRepos', (d) => d.skills.listPopularRepos()),
    'skills.ensureUserFolder': () => served('skills.ensureUserFolder', (d) => ({ folder: d.ensureUserSkillsFolder() })),
    'skillPlugins.scanLinked': (input, asking) =>
      at('skillPlugins.scanLinked', [sourceFolder(input.sourceId)], asking, (d) => d.skills.scanLinkedPlugin(input)),
    // Owner-only (the table says why), and held to known folders where the owner's connection is.
    'skillPlugins.install': ({ commandId: _commandId, ...input }, asking) =>
      at('skillPlugins.install', [sourceFolder(input.sourceId), input.workspaceRoot], asking, (d) =>
        d.skills.installPlugin(input),
      ),
    'skillPlugins.uninstall': ({ commandId: _commandId, ...input }, asking) =>
      at('skillPlugins.uninstall', [sourceFolder(input.sourceId), input.workspaceRoot], asking, (d) =>
        d.skills.uninstallPlugin(input),
      ),
    'skillPlugins.listInstalled': ({ workspaceFolder }, asking) =>
      at('skillPlugins.listInstalled', [workspaceFolder], asking, (d) =>
        d.skills.listInstalledPlugins({ workspaceRoot: workspaceFolder }),
      ),
    'workspaceSkills.list': ({ workspaceFolder, includeGlobal }, asking) =>
      at('workspaceSkills.list', [workspaceFolder], asking, (d) =>
        d.workspaceSkills.listWorkspaceSkills({
          workspaceRoot: workspaceFolder,
          ...(includeGlobal ? { includeGlobal } : {}),
        }),
      ),
    'installedSkills.list': ({ workspaceFolder, ...cli }, asking) =>
      at('installedSkills.list', [workspaceFolder], asking, (d) =>
        d.installedSkills.list({ workspaceRoot: workspaceFolder, ...cli }),
      ),
    'installedSkills.remove': ({ commandId: _commandId, workspaceFolder, ...rest }, asking) =>
      at('installedSkills.remove', [workspaceFolder], asking, (d) =>
        d.installedSkills.remove({ workspaceRoot: workspaceFolder, ...rest }),
      ),
    'agentCapabilities.resolve': ({ workspaceFolder, pluginId, includeGlobal }, asking) =>
      at('agentCapabilities.resolve', [workspaceFolder], asking, (d) =>
        d.agentCapabilities.resolve({
          workspaceRoot: workspaceFolder,
          pluginId,
          ...(includeGlobal ? { includeGlobal } : {}),
        }),
      ),
    'agentSkills.attach': ({ workspaceFolder, skillId }, asking) =>
      at('agentSkills.attach', [workspaceFolder], asking, (d) =>
        d.agentSkillInstaller.attach({ workspaceRoot: workspaceFolder, skillId }),
      ),
    'designSystem.library': (_params, asking) =>
      served('designSystem.library', async (d) => ({
        entries: await visible((await d.designSystem.library()).entries, asking),
      })),
    'designSystem.arrivals': (_params, asking) =>
      served('designSystem.arrivals', async (d) => ({
        bundles: await visible((await d.designSystem.arrivals()).bundles, asking),
      })),
    'designSystem.register': ({ folder }, asking) =>
      at('designSystem.register', [folder], asking, (d) => d.designSystem.register(folder)),
    // A library entry is the folder it was registered at: forgetting it is naming that folder.
    'designSystem.forget': async ({ id }, asking) => {
      if (!skills) return refuse('unavailable', 'This Studio does not serve designSystem.forget.')
      return at('designSystem.forget', [await libraryFolder(skills, id)], asking, (d) => d.designSystem.forget(id))
    },
    'designSystem.read': ({ bundleFolder }, asking) =>
      at('designSystem.read', [bundleFolder], asking, (d) => d.designSystem.read(bundleFolder)),
    'designSystem.seed': ({ commandId: _commandId, ...input }, asking) =>
      at('designSystem.seed', [input.sourceFolder, input.targetFolder], asking, (d) => d.designSystem.seed(input)),
    // Owner-only (the table says why), and held to known folders where the owner's connection is.
    'designSystem.lint': ({ bundleFolder }, asking) =>
      at('designSystem.lint', [bundleFolder], asking, (d) => d.designSystem.lint(bundleFolder)),
    'designSystem.attach': async ({ source, workspaceFolder }, asking) => {
      if (source.kind === 'folder')
        return at('designSystem.attach', [source.folder, workspaceFolder], asking, (d) =>
          d.designSystem.attach({ kind: 'folder', path: source.folder }, workspaceFolder),
        )
      // A library entry is the folder it was registered at: that folder is
      // what the attach copies from, so it is what the asker must be able to name.
      if (!skills) return refuse('unavailable', 'This Studio does not serve designSystem.attach.')
      return at('designSystem.attach', [await libraryFolder(skills, source.id), workspaceFolder], asking, (d) =>
        d.designSystem.attach({ kind: 'library', id: source.id }, workspaceFolder),
      )
    },
    'designSystem.detach': ({ workspaceFolder }, asking) =>
      at('designSystem.detach', [workspaceFolder], asking, (d) => d.designSystem.detach(workspaceFolder)),
    // Owner-only (the table says why), and held to known folders where the owner's
    // connection is: the workspace a card installs into. Its clone parent is the
    // open workspace's parent, never itself a folder Studio knows, and a clone
    // only makes a new folder there (run-card.ts refuses to adopt one that is not
    // that repository's).
    'cards.run': ({ commandId: _commandId, ...input }, asking) =>
      at('cards.run', [input.workspaceRoot], asking, (d) => d.runCard(input)),
  }
}
