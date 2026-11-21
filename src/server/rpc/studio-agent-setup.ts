import type {
  StudioAgentSetupMethod,
  StudioAgentSetupMethodMap,
  StudioGrant,
  StudioHandlerOf,
} from '../../../packages/studio-protocol/src/public'
import { resolve } from 'node:path'
import { isMachinePath } from '../../shared/machine-paths'
import type { StudioAgentSetup } from '../agent-setup/agent-setup-domain'
import type { StudioRequestContext } from './studio-rpc-types'

// The router's answers to `knowledge.resolveRoot`, `mcp.sync`,
// `agentConfig.*`, `builtinSkills.*` and `areaSkills.*`: each method's domain
// call, once the router has held the grant to the method's scope. The rule of
// their own: a workspace folder a client that is not an owner names must be
// one Studio knows (as a file's; the wire calls it `workspaceFolder`, never a
// conversation's `workspaceRoot` address, which only an owner names), and a workspace on an SSH machine is answered in words, as
// the window's IPC answered it, until that machine's own server serves it.

type Asking = { grant: StudioGrant; context: StudioRequestContext }

export type StudioAgentSetupHandlers = {
  readonly [M in StudioAgentSetupMethod]: StudioHandlerOf<StudioAgentSetupMethodMap[M], Asking>
}

export type StudioAgentSetupHandlerOptions = {
  /** The services; without them, every method is answered `unavailable`. */
  setup?: StudioAgentSetup
  /** Whether the asker may name this folder: any, for an owner's own connection; else one Studio knows. */
  mayName(path: string, asking: Asking): Promise<boolean>
}

const UNKNOWN_FOLDER = 'That folder is not one Studio knows.'

function onMachine(method: string): string {
  return `Not available for SSH machines yet (Studio's ${method}).`
}

type Refused<C extends 'unavailable' | 'not_found'> = { ok: false; error: { code: C; message: string } }

const refuse = <C extends 'unavailable' | 'not_found'>(code: C, message: string): Refused<C> => ({
  ok: false,
  error: { code, message },
})

function ok<T>(result: T): { ok: true; result: T } {
  return { ok: true, result }
}

export function createStudioAgentSetupHandlers(options: StudioAgentSetupHandlerOptions): StudioAgentSetupHandlers {
  const { setup } = options
  const unserved = (method: StudioAgentSetupMethod) => refuse('unavailable', `This Studio does not serve ${method}.`)

  /**
   * Answer from the domain about a workspace the asker may name, or why not.
   * A knowledge folder under it is held to the same rule, resolved: a relative
   * root may climb (`../notes`), and it must not climb out of what the asker
   * may name.
   */
  async function about<T>(
    method: StudioAgentSetupMethod,
    workspaceRoot: string | null,
    asking: Asking,
    answer: (domain: StudioAgentSetup) => Promise<T> | T,
    knowledgeRoot: string | null = null,
  ): Promise<{ ok: true; result: T } | Refused<'unavailable' | 'not_found'>> {
    if (!setup) return unserved(method)
    if (workspaceRoot !== null) {
      if (isMachinePath(workspaceRoot)) return refuse('unavailable', onMachine(method))
      if (!(await options.mayName(workspaceRoot, asking))) return refuse('not_found', UNKNOWN_FOLDER)
      if (knowledgeRoot !== null && !(await options.mayName(resolve(workspaceRoot, knowledgeRoot), asking)))
        return refuse('not_found', UNKNOWN_FOLDER)
    }
    return ok(await answer(setup))
  }

  return {
    'knowledge.resolveRoot': ({ workspaceFolder, relativeRoot }, asking) =>
      about(
        'knowledge.resolveRoot',
        workspaceFolder,
        asking,
        (domain) => domain.resolveKnowledgeRoot(workspaceFolder, relativeRoot),
        relativeRoot,
      ),
    'mcp.sync': ({ commandId: _commandId, ...input }, asking) =>
      about('mcp.sync', input.workspaceRoot, asking, (domain) => domain.syncMcp(input)),
    'agentConfig.detect': async (input) =>
      setup ? ok(await setup.detectAgentConfig(input)) : unserved('agentConfig.detect'),
    'agentConfig.adopt': ({ commandId: _commandId, ...input }, asking) =>
      about('agentConfig.adopt', input.workspaceRoot, asking, (domain) => domain.adoptAgentConfig(input)),
    'builtinSkills.list': async () =>
      setup ? ok({ skills: await setup.builtinSkills() }) : unserved('builtinSkills.list'),
    'builtinSkills.status': ({ workspaceFolder, skillId }, asking) =>
      about('builtinSkills.status', workspaceFolder, asking, (domain) =>
        domain.builtinSkillStatus(workspaceFolder, skillId),
      ),
    'areaSkills.get': () => (setup ? ok(setup.areaSkills()) : unserved('areaSkills.get')),
    'areaSkills.setEnabled': async ({ skillId, enabled }) =>
      setup ? ok(await setup.setAreaSkillEnabled(skillId, enabled)) : unserved('areaSkills.setEnabled'),
    'areaSkills.dismiss': async ({ skillId }) =>
      setup ? ok(await setup.dismissAreaSkill(skillId)) : unserved('areaSkills.dismiss'),
  }
}
