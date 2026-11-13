import type { StudioClient } from '../../../../packages/client-runtime/src/public'
import type {
  StudioCapability,
  StudioMethod,
  StudioMethodParams,
  StudioMethodResult,
} from '../../../../packages/studio-protocol/src/public'
import { machinePanePathsIn, machinePanePathsOut } from '../../../shared/machine-path-edge'
import { machineRouteOfPath, machineSpellingOf } from '../../../shared/machine-spelling'
import { withEnvironmentStudio } from './environmentStudio'
import { windowStudioClient } from './windowStudioClient'

// Which Studio answers the window's files and git about a folder: the one on
// the folder's machine (design-wsl-ssh-direct PR 2, PR 3c). A folder on this
// computer (a Windows drive included) is the window's own Studio's. A folder
// on an SSH machine, spelled `ssh://<id>/…` here, or in a WSL distribution,
// spelled by its share (`\\wsl.localhost\<distro>\…`), is asked of that
// machine's own Studio, on this window's client of it (`environmentStudio.ts`,
// the one the chat view uses), with the same `files.*` and `git.*` methods and
// the window's own grant there. Its paths are respelled at that edge
// (`machine-path-edge.ts`). Nothing here tells the methods apart: each is
// asked where its folders are.

/** The members of what a pane sends that name a folder or file by path. */
const PATH_MEMBERS: ReadonlySet<string> = new Set([
  'path',
  'rootPath',
  'parentPath',
  'toFolder',
  'folderPath',
  'repoRoot',
  'checkoutPath',
  'worktreePath',
  'roots',
  'ref',
])

/** How long one ask of a machine waits: a search or a commit there takes as long as here. */
const MACHINE_ASK_MS = 120_000

const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u

/** Two machines, or a machine and this computer, named in one ask; or a machine path that names none. */
export const MIXED_MACHINES =
  'That names files on two machines, or a machine path Studio cannot read: Studio asks one machine at a time.'

/** `machine` is the route of the machine an ask's folders are on. */
type Where = { machine: string } | { machine: null } | { mixed: true }

/** The machine an ask's folders are on, from the members that name one; this computer's for none. */
export function machineOfAsk(params: unknown): Where {
  const routes = new Set<string>()
  let local = false
  const look = (value: unknown, depth: number): void => {
    if (typeof value === 'string') {
      const route = machineRouteOfPath(value)
      if (route !== null) routes.add(route ?? '')
      else if (ABSOLUTE.test(value)) local = true
      return
    }
    if (depth > 2) return
    if (Array.isArray(value)) for (const entry of value) look(entry, depth + 1)
    else if (typeof value === 'object' && value !== null)
      for (const [member, entry] of Object.entries(value)) if (PATH_MEMBERS.has(member)) look(entry, depth + 1)
  }
  if (typeof params === 'object' && params !== null)
    for (const [member, value] of Object.entries(params)) if (PATH_MEMBERS.has(member)) look(value, 0)
  if (routes.size === 0) return { machine: null }
  const [route] = [...routes]
  if (routes.size > 1 || local || !route) return { mixed: true }
  return { machine: route }
}

/**
 * Ask `method` of the Studio whose machine the folders in `params` are on,
 * held to a capability its welcome must name (else `unserved`, in words).
 */
export async function askStudioOfPaths<M extends StudioMethod>(
  method: M,
  params: StudioMethodParams<M>,
  capability: StudioCapability,
  unserved: string,
): Promise<StudioMethodResult<M>> {
  const where = machineOfAsk(params)
  if ('mixed' in where) throw new Error(MIXED_MACHINES)
  if (where.machine === null) {
    const client = await windowStudioClient()
    if (!client.supports(capability)) throw new Error(unserved)
    return client.request(method, params)
  }
  const route = where.machine
  const ssh = route.startsWith('ssh:')
  return withEnvironmentStudio(
    { route, name: ssh ? 'The SSH machine' : `WSL: ${route.slice('wsl:'.length)}` },
    async (client: StudioClient) => {
      if (!client.supports(capability))
        throw new Error(
          ssh
            ? 'The Studio server on that SSH machine is older than this app. Update it in Settings › Machines.'
            : 'The Studio server in that WSL distribution is older than this app. Restart it in Settings › Machines.',
        )
      const spelling = machineSpellingOf(route, () => client.welcome.environment.driveMountRoot)
      if (!spelling) throw new Error(MIXED_MACHINES)
      const answer = await (client.request as (method: string, params: unknown) => Promise<unknown>)(
        method,
        machinePanePathsIn(spelling, params),
      )
      return machinePanePathsOut(spelling, answer) as StudioMethodResult<M>
    },
    { timeoutMs: MACHINE_ASK_MS },
  )
}
