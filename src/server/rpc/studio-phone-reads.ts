import type {
  StudioBacklogFolderMethodMap,
  StudioBacklogMethodMap,
  StudioGrant,
  StudioHandlerOf,
  StudioPullRequestReadsMethodMap,
  StudioSharesMethodMap,
} from '../../../packages/studio-protocol/src/public'
import type { StudioPhoneReads } from '../backlog/backlog-domain'
import { isMachinePath } from '../../shared/machine-paths'

// The router's answers to `backlog.*`, `shares.list` and the pull request
// reads, once the router has held the grant to each method's scope. An update
// is carried out once per command id: a retry after a dropped connection is
// answered with the first answer. The backlog by its folder (the desktop's
// own Backlog panel) is an owner's, which the router holds; a browser on the
// tailnet is held here to the folders Studio knows, and a folder on an SSH
// machine is refused in words.

type Asking = { grant: StudioGrant }
type Map = StudioBacklogMethodMap &
  StudioBacklogFolderMethodMap &
  StudioSharesMethodMap &
  StudioPullRequestReadsMethodMap

export type StudioPhoneReadsHandlers<A extends Asking = Asking> = {
  readonly [M in keyof Map]: StudioHandlerOf<Map[M], A>
}

type Code = 'not_found' | 'invalid_params' | 'unavailable'
type Answer<R, C extends Code = Code> = { ok: true; result: R } | { ok: false; error: { code: C; message: string } }

export type StudioPhoneReadsHandlerOptions<A extends Asking = Asking> = {
  /** The reads; without them every method is answered `unavailable`. */
  reads?: StudioPhoneReads
  /** The first answer to a method's command id, for every retry of it; new work otherwise. */
  kept<R, C extends Code>(
    method: keyof Map,
    asking: A,
    commandId: string,
    work: () => Promise<Answer<R, C>>,
  ): Promise<Answer<R, C | 'unavailable'>>
  /** Whether the asker may name this folder: any, for an owner's own connection; otherwise one Studio knows. */
  mayName(folder: string, asking: A): Promise<boolean>
}

const unserved = (method: keyof Map) =>
  ({ ok: false, error: { code: 'unavailable', message: `This Studio does not serve ${method}.` } }) as const

function answer<T>(outcome: { ok: true; value: T } | { ok: false; code: Code; message: string }): Answer<T> {
  return outcome.ok
    ? { ok: true, result: outcome.value }
    : { ok: false, error: { code: outcome.code, message: outcome.message } }
}

/** A read of a pull request names no record of this Studio's: one it could not find is one it could not read. */
function read<T>(
  outcome: { ok: true; value: T } | { ok: false; code: Code; message: string },
): Answer<T, 'invalid_params' | 'unavailable'> {
  if (outcome.ok) return { ok: true, result: outcome.value }
  return {
    ok: false,
    error: { code: outcome.code === 'invalid_params' ? 'invalid_params' : 'unavailable', message: outcome.message },
  }
}

const SSH_FOLDER = 'A backlog on an SSH machine is not served from here yet.'
const UNKNOWN_FOLDER = 'That folder is not one of the projects Studio holds.'

export function createStudioPhoneReadsHandlers<A extends Asking>(
  options: StudioPhoneReadsHandlerOptions<A>,
): StudioPhoneReadsHandlers<A> {
  const { reads } = options
  /** A folder method's work, once the folder is one the asker may name; a write's once per command id. */
  async function inFolder<R>(
    method: keyof StudioBacklogFolderMethodMap,
    asking: A,
    workspaceRoot: string,
    commandId: string | null,
    work: (folders: StudioPhoneReads['backlog']['folders']) => Promise<R>,
  ): Promise<Answer<R, 'invalid_params' | 'unavailable'>> {
    if (!reads) return unserved(method)
    if (isMachinePath(workspaceRoot)) return { ok: false, error: { code: 'unavailable', message: SSH_FOLDER } }
    if (!(await options.mayName(workspaceRoot, asking)))
      return { ok: false, error: { code: 'invalid_params', message: UNKNOWN_FOLDER } }
    const run = async () => ({ ok: true as const, result: await work(reads.backlog.folders) })
    return commandId === null ? run() : options.kept(method, asking, commandId, run)
  }
  return {
    'backlog.location': ({ workspaceRoot }, asking) =>
      inFolder('backlog.location', asking, workspaceRoot, null, (folders) => folders.location(workspaceRoot)),
    // The folder it points the backlog at is held as the project's is: one a
    // browser on the tailnet could not name, it cannot have read or written.
    'backlog.setRoot': async ({ commandId, workspaceRoot, root }, asking) =>
      root !== null && (isMachinePath(root) || !(await options.mayName(root, asking)))
        ? { ok: false, error: { code: 'invalid_params', message: UNKNOWN_FOLDER } }
        : inFolder('backlog.setRoot', asking, workspaceRoot, commandId, (folders) =>
            folders.setRoot(workspaceRoot, root),
          ),
    'backlog.ensureRecords': ({ commandId, workspaceRoot, items }, asking) =>
      inFolder('backlog.ensureRecords', asking, workspaceRoot, commandId, (folders) =>
        folders.ensureRecords(workspaceRoot, items),
      ),
    'backlog.ensureIds': ({ commandId, workspaceRoot, items }, asking) =>
      inFolder('backlog.ensureIds', asking, workspaceRoot, commandId, (folders) =>
        folders.ensureIds(workspaceRoot, items),
      ),
    'backlog.edit': ({ commandId, workspaceRoot, relativePath, edit }, asking) =>
      inFolder('backlog.edit', asking, workspaceRoot, commandId, (folders) =>
        folders.edit(workspaceRoot, relativePath, edit),
      ),
    'backlog.createEpic': ({ commandId, workspaceRoot, title }, asking) =>
      inFolder('backlog.createEpic', asking, workspaceRoot, commandId, (folders) =>
        folders.createEpic(workspaceRoot, title),
      ),
    'backlog.list': async () =>
      reads ? { ok: true, result: { workspaces: await reads.backlog.list() } } : unserved('backlog.list'),
    'backlog.update': ({ commandId, ...update }, asking) =>
      reads
        ? options.kept('backlog.update', asking, commandId, async () => answer(await reads.backlog.update(update)))
        : unserved('backlog.update'),
    'shares.list': async () =>
      reads ? { ok: true, result: { shares: await reads.shares() } } : unserved('shares.list'),
    'pullRequests.detail': async ({ url }) =>
      reads ? read(await reads.pullRequest(url)) : unserved('pullRequests.detail'),
    'pullRequests.diff': async ({ url, path, offset }) =>
      reads ? read(await reads.pullRequestDiff(url, path, offset ?? 0)) : unserved('pullRequests.diff'),
  }
}
