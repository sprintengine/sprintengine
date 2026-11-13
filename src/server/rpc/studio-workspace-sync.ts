import type {
  StudioGrant,
  StudioHandlerOf,
  StudioWorkspaceSyncMethod,
  StudioWorkspaceSyncMethodMap,
} from '../../../packages/studio-protocol/src/public'
import type { StudioRequestContext } from './studio-rpc-types'
import type { StudioWorkspaceSync } from '../workspaces/studio-workspace-sync'

// The router's answers to the desktop's own windows' registry methods, once it
// has held the grant (an owner's alone). A change is carried out once per
// command id. Two rules the web tab's IPC tunnel kept come with them: what
// only a desktop window knows (its Settled chats settings, its module chats'
// run states) is not taken from a browser, whose settings start at the
// defaults and which loads no module, so its push is answered and not
// applied, as the web build's stand-ins did; a browser on the tailnet
// makes a workspace only on a folder Studio already has one for; and New
// chat's "No project" is the desktop's, refused to a browser as the tunnel
// refused it: a tab is not told where on this disk those chats live, and makes
// no folder there.

type Asking = { grant: StudioGrant; context: StudioRequestContext }

export type StudioWorkspaceSyncHandlers<A extends Asking = Asking> = {
  readonly [M in StudioWorkspaceSyncMethod]: StudioHandlerOf<StudioWorkspaceSyncMethodMap[M], A>
}

type Answer<R> =
  { ok: true; result: R } | { ok: false; error: { code: 'invalid_params' | 'unavailable'; message: string } }

export type StudioWorkspaceSyncHandlerOptions<A extends Asking = Asking> = {
  /** The registry; without it every method is answered `unavailable`. */
  sync?: StudioWorkspaceSync
  /** The first answer to a method's command id, for every retry of it; new work otherwise. */
  kept<R>(
    method: StudioWorkspaceSyncMethod,
    asking: A,
    commandId: string,
    work: () => Promise<Answer<R>>,
  ): Promise<Answer<R> | { ok: false; error: { code: 'unavailable'; message: string } }>
  /** Whether the asker may name this folder: any, for an owner's own connection; otherwise one Studio knows. */
  mayName(folder: string, asking: A): Promise<boolean>
}

const UNKNOWN_FOLDER = 'A browser on the tailnet starts a chat only in a folder Studio already has.'
const NO_PROJECT_DESKTOP_ONLY = 'A chat without a project is started from the desktop app.'

const unserved = (method: StudioWorkspaceSyncMethod) =>
  ({ ok: false, error: { code: 'unavailable', message: `This Studio does not serve ${method}.` } }) as const
const desktopOnly = (message: string) => ({ ok: false, error: { code: 'unavailable', message } }) as const
const refused = (message: string) => ({ ok: false, error: { code: 'invalid_params', message } }) as const
const ok = <R>(result: R): Answer<R> => ({ ok: true, result })

/** The folder a `workspace.created` command names, when it is one. */
function createdFolder(command: Record<string, unknown>): string | null {
  if (command.type !== 'workspace.created') return null
  const payload = command.payload as { insert?: { folderPath?: unknown } } | undefined
  const folder = payload?.insert?.folderPath
  return typeof folder === 'string' && folder.trim() ? folder : null
}

export function createStudioWorkspaceSyncHandlers<A extends Asking>(
  options: StudioWorkspaceSyncHandlerOptions<A>,
): StudioWorkspaceSyncHandlers<A> {
  const { sync } = options
  const write = <R>(method: StudioWorkspaceSyncMethod, asking: A, commandId: string, work: () => Promise<Answer<R>>) =>
    sync ? options.kept(method, asking, commandId, work) : Promise.resolve(unserved(method))
  return {
    'workspaceSync.snapshot': async () => (sync ? ok(sync.snapshot()) : unserved('workspaceSync.snapshot')),
    'workspaceSync.eventsAfter': async ({ sequence }) =>
      sync ? ok({ events: sync.eventsAfter(sequence) }) : unserved('workspaceSync.eventsAfter'),
    'workspaceSync.dispatch': ({ commandId, windowId, command }, asking) =>
      write('workspaceSync.dispatch', asking, commandId, async () => {
        const folder = createdFolder(command)
        if (folder && asking.context.knownFoldersOnly && !(await options.mayName(folder, asking)))
          return refused(UNKNOWN_FOLDER)
        return ok(sync!.dispatch(command, windowId))
      }),
    'workspaceSync.lifecycle': ({ commandId, request }, asking) =>
      write('workspaceSync.lifecycle', asking, commandId, async () => ok(sync!.lifecycle(request))),
    'workspaceSync.setSettledChatsSettings': ({ commandId, settings }, asking) =>
      write('workspaceSync.setSettledChatsSettings', asking, commandId, async () => {
        if (!asking.context.browser) sync!.setSettledChatsSettings(settings)
        return ok({})
      }),
    'workspaceSync.setModuleRunStates': ({ commandId, states }, asking) =>
      write('workspaceSync.setModuleRunStates', asking, commandId, async () => {
        if (!asking.context.browser) sync!.setModuleRunStates(states)
        return ok({})
      }),
    'workspaceRegistry.needsHydration': async () =>
      sync ? ok({ needsHydration: sync.needsHydration() }) : unserved('workspaceRegistry.needsHydration'),
    'workspaceRegistry.hydrate': ({ commandId, payload }, asking) =>
      write('workspaceRegistry.hydrate', asking, commandId, async () => ok(sync!.hydrate(payload))),
    'workspaceBackup.read': async () => (sync ? ok(await sync.backupRead()) : unserved('workspaceBackup.read')),
    'workspaceBackup.write': ({ commandId, payload }, asking) =>
      write('workspaceBackup.write', asking, commandId, async () => ok(await sync!.backupWrite(payload))),
    'projectlessChats.root': async (_params, asking) =>
      asking.context.browser
        ? desktopOnly(NO_PROJECT_DESKTOP_ONLY)
        : sync
          ? ok({ path: await sync.projectlessRoot() })
          : unserved('projectlessChats.root'),
    'projectlessChats.createFolder': ({ commandId, prompt }, asking) =>
      asking.context.browser
        ? Promise.resolve(desktopOnly(NO_PROJECT_DESKTOP_ONLY))
        : write('projectlessChats.createFolder', asking, commandId, async () =>
            ok({ path: await sync!.createProjectlessFolder(prompt ?? null) }),
          ),
  }
}
