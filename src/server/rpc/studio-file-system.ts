import { realpath } from 'node:fs/promises'

import type {
  StudioErrorBody,
  StudioFileSystemMethod,
  StudioFileSystemMethodMap,
  StudioGrant,
  StudioHandlerOf,
  StudioMethodParams,
  StudioMethodResult,
} from '../../../packages/studio-protocol/src/public'
import { spelledResult } from '../../main/environments/ssh/machine-ipc'
import { expandHomePath } from '../../main/home-path'
import { confineToRoots } from '../../main/studio-rpc/studio-file-confinement'
import { isMachinePath, parseMachinePath } from '../../shared/machine-paths'
import { notOnMachineYet } from '../../shared/machine-channels'
import type { StudioFileSystem, StudioFileSystemWatch } from '../files/studio-file-system'
import type { StudioRequestContext } from './studio-rpc-types'

// The router's answers to the files on this machine by path: the
// `file-system` family, and the search, stat, picture and repository-root
// reads `chat.ts` declares, which the same core serves with or without a
// chat surface.
//
// Who may name what. An owner's own connection names any path as written.
// Every other connection, and an owner's held to known folders (a tailnet
// one), names a path only where it really is inside the folders Studio
// knows: the path is resolved first, every link followed and every `..`
// taken (`confineToRoots`), and the work is done on that real path, so a link
// swapped after the check cannot lead elsewhere. A path outside is answered
// as not there. Writes are held to the workspaces' own folders, and the
// workspace folder itself is never renamed, moved or trashed by such a
// client.
//
// A path on an SSH machine (`ssh://<id>/…`) is an owner's only. The reads
// that machine's server answers go there, as the window's IPC sent them
// (`machine-channels.ts`); the rest are refused in words. This forward goes
// when the SSH machines' panes reach their own servers.

export type StudioFileSystemAsking = {
  grant: StudioGrant
  context: StudioRequestContext
  voice: { failed(code: 'unavailable', detail: string | undefined, context: string): unknown }
}

/** An SSH machine's server, asked about a machine channel; rejects in words when it cannot be reached. */
export type StudioMachineCall = (id: string, channel: string, args: unknown[]) => Promise<unknown>

type Answer<M extends StudioFileSystemMethod> = StudioHandlerOf<StudioFileSystemMethodMap[M], StudioFileSystemAsking>

export type StudioFileSystemHandlers = { readonly [M in StudioFileSystemMethod]: Answer<M> }

type Refused<C extends string> = { ok: false; error: StudioErrorBody & { code: C } }
type Kept = <A extends { ok: boolean; error?: StudioErrorBody }>(
  id: string,
  work: () => Promise<A>,
  voice: StudioFileSystemAsking['voice'],
  method: string,
) => Promise<A | Refused<'unavailable'>>

export type StudioFileSystemHandlerOptions = {
  /** The files; without them, every method is answered `unavailable`. */
  fileSystem?: StudioFileSystem
  /** SSH machines' servers, for an owner's `ssh://` path. */
  machine?: StudioMachineCall
  /** The first answer to a command id is every retry's. */
  once: Kept
  /** A client's command id, namespaced by the client. */
  runtimeId(grant: StudioGrant, commandId: string): string
}

export const UNKNOWN_PATH = 'That path is not in a folder Studio knows.'
const ROOT_ITSELF = 'A workspace’s own folder is not renamed, moved or removed from here.'

const refuse = <C extends string>(code: C, message: string): Refused<C> => ({ ok: false, error: { code, message } })
const ok = <T>(result: T): { ok: true; result: T } => ({ ok: true, result })

/** Where a path the asker named is: its path here, or a path on an SSH machine. */
export type Placed =
  | { ok: true; path: string; machine?: undefined }
  | { ok: true; path: string; machine: { id: string; path: string } }
  | { ok: false }

/** Whether the asker names any path as written: an owner's connection not held to known folders. */
export function namesAnyPath(asking: Pick<StudioFileSystemAsking, 'grant' | 'context'>): boolean {
  return asking.grant.owner && !asking.context.knownFoldersOnly
}

/**
 * The path to work on for `raw`: as written for an owner; for anyone else its
 * real path when that is inside the roots for `purpose`, else none.
 */
export async function placePath(
  fileSystem: StudioFileSystem,
  raw: string,
  asking: Pick<StudioFileSystemAsking, 'grant' | 'context'>,
  purpose: 'read' | 'write',
): Promise<Placed> {
  const anyPath = namesAnyPath(asking)
  if (isMachinePath(raw)) {
    const machine = anyPath ? parseMachinePath(raw) : null
    return machine ? { ok: true, path: raw, machine } : { ok: false }
  }
  if (anyPath) return { ok: true, path: raw }
  const roots = purpose === 'write' ? await fileSystem.writableRoots() : await fileSystem.readableRoots()
  const confined = await confineToRoots(expandHomePath(raw), roots)
  return confined.ok ? { ok: true, path: confined.path } : { ok: false }
}

/** Whether a real path is one of the roots itself (a workspace's folder). */
async function isRoot(fileSystem: StudioFileSystem, path: string): Promise<boolean> {
  for (const root of await fileSystem.writableRoots()) {
    const real = await realpath(root).catch(() => null)
    if (real === path) return true
  }
  return false
}

export function createStudioFileSystemHandlers(options: StudioFileSystemHandlerOptions) {
  const { fileSystem } = options
  const unserved = (method: string) => refuse('unavailable', `This Studio does not serve ${method}.`)

  /** Ask the SSH machine's server, its answer's paths spelled for this computer again. */
  async function onMachine<T>(machine: { id: string; path: string }, channel: string, args: unknown[]): Promise<T> {
    if (!options.machine) throw new Error(notOnMachineYet(channel))
    return spelledResult(machine.id, channel, await options.machine(machine.id, channel, args)) as T
  }

  /**
   * Read about one path: refused as unknown when the asker may not name it,
   * sent to its machine where that machine answers `channel`, refused in words
   * where it does not.
   */
  async function reading<T>(
    method: string,
    raw: string,
    asking: StudioFileSystemAsking,
    here: (fs: StudioFileSystem, path: string) => Promise<T>,
    channel: string | null,
    machineArgs: (path: string) => unknown[] = (path) => [path],
  ): Promise<{ ok: true; result: T } | Refused<'unavailable' | 'not_found'>> {
    if (!fileSystem) return unserved(method)
    const at = await placePath(fileSystem, raw, asking, 'read')
    if (!at.ok) return refuse('not_found', UNKNOWN_PATH)
    if (at.machine) {
      if (!channel) return refuse('unavailable', notOnMachineYet(method))
      return ok(await onMachine<T>(at.machine, channel, machineArgs(at.machine.path)))
    }
    return ok(await here(fileSystem, at.path))
  }

  /** Carry out a write once per command id, on paths the asker may change. */
  function writing<M extends StudioFileSystemMethod>(
    method: M,
    params: StudioMethodParams<M> & { commandId: string },
    asking: StudioFileSystemAsking,
    paths: Array<{ raw: string; purpose: 'read' | 'write'; notRoot?: boolean }>,
    work: (fs: StudioFileSystem, placed: string[]) => Promise<StudioMethodResult<M>>,
  ) {
    if (!fileSystem) return unserved(method)
    return options.once(
      `${method}:${options.runtimeId(asking.grant, params.commandId)}`,
      async (): Promise<{ ok: true; result: StudioMethodResult<M> } | Refused<'not_found' | 'unavailable'>> => {
        const placed: string[] = []
        for (const { raw, purpose, notRoot } of paths) {
          const at = await placePath(fileSystem, raw, asking, purpose)
          if (!at.ok) return refuse('not_found', UNKNOWN_PATH)
          if (at.machine) return refuse('unavailable', notOnMachineYet(method))
          if (notRoot && !namesAnyPath(asking) && (await isRoot(fileSystem, at.path)))
            return refuse('not_found', ROOT_ITSELF)
          placed.push(at.path)
        }
        return ok(await work(fileSystem, placed))
      },
      asking.voice,
      method,
    )
  }

  const handlers: StudioFileSystemHandlers = {
    'files.listDirectory': async ({ path }, asking) => {
      if (!fileSystem) return unserved('files.listDirectory')
      const at = await placePath(fileSystem, path, asking, 'read')
      if (!at.ok) return refuse('not_found', UNKNOWN_PATH)
      const entries = at.machine
        ? await onMachine<Array<{ name: string; isDir: boolean }>>(at.machine, 'fs:readdir', [at.machine.path])
        : await fileSystem.listDirectory(at.path)
      return ok({ entries })
    },
    'files.readText': async ({ path }, asking) => {
      if (!fileSystem) return unserved('files.readText')
      const at = await placePath(fileSystem, path, asking, 'read')
      if (!at.ok) return refuse('not_found', UNKNOWN_PATH)
      const text = at.machine
        ? await onMachine<string>(at.machine, 'fs:readfile', [at.machine.path])
        : await fileSystem.readText(at.path)
      return ok({ text })
    },
    'files.exists': async ({ path }, asking) => {
      if (!fileSystem) return unserved('files.exists')
      const at = await placePath(fileSystem, path, asking, 'read')
      if (!at.ok) return ok({ exists: false })
      const exists = at.machine
        ? await onMachine<boolean>(at.machine, 'fs:path-exists', [at.machine.path])
        : await fileSystem.exists(at.path)
      return ok({ exists })
    },
    'files.checkWorkspaceFolder': ({ path }, asking) =>
      reading(
        'files.checkWorkspaceFolder',
        path,
        asking,
        (fs, at) => fs.checkWorkspaceFolder(at),
        'fs:check-workspace-folder',
      ),
    'files.projectLogo': async ({ folderPath }, asking) => {
      if (!fileSystem) return unserved('files.projectLogo')
      const at = await placePath(fileSystem, folderPath, asking, 'read')
      if (!at.ok || at.machine) return ok({ logo: null })
      return ok({ logo: await fileSystem.projectLogo(at.path) })
    },
    'files.projectIcon': async ({ path }, asking) => {
      if (!fileSystem) return unserved('files.projectIcon')
      const at = await placePath(fileSystem, path, asking, 'read')
      if (!at.ok || at.machine) return ok({ logo: null })
      return ok({ logo: await fileSystem.projectIcon(at.path) })
    },
    'files.searchContent': ({ rootPath, query, limit }, asking) =>
      reading(
        'files.searchContent',
        rootPath,
        asking,
        (fs, at) =>
          fs.searchContent(asking.context.slot, { rootPath: at, query, ...(limit === undefined ? {} : { limit }) }),
        null,
      ),
    'files.cancelContentSearch': (_params, { context }) => {
      if (!fileSystem) return unserved('files.cancelContentSearch')
      fileSystem.cancelContentSearch(context.slot)
      return ok({})
    },
    'files.defaultWorkspaceParent': async (_params, asking) => {
      if (!fileSystem) return unserved('files.defaultWorkspaceParent')
      const path = fileSystem.defaultWorkspaceParent()
      if (path === null || namesAnyPath(asking)) return ok({ path })
      const at = await placePath(fileSystem, path, asking, 'write')
      return ok({ path: at.ok ? at.path : null })
    },
    'files.writeText': (params, asking) =>
      writing('files.writeText', params, asking, [{ raw: params.path, purpose: 'write' }], async (fs, [path]) => {
        // A client held to known folders writes only inside them: its own
        // roots are those, whatever it named.
        const roots = namesAnyPath(asking) ? (params.roots ?? []) : await fs.writableRoots()
        await fs.writeText(path!, params.text, roots)
        return {}
      }),
    // It names no path: the picture goes to Studio's own picture folder.
    'files.saveDroppedImage': ({ mediaType, dataBase64, commandId }, asking) => {
      if (!fileSystem) return unserved('files.saveDroppedImage')
      return options.once(
        `files.saveDroppedImage:${options.runtimeId(asking.grant, commandId)}`,
        async () => ok({ path: await fileSystem.saveDroppedImage({ mediaType, dataBase64 }) }),
        asking.voice,
        'files.saveDroppedImage',
      )
    },
    'files.createFile': (params, asking) =>
      writing('files.createFile', params, asking, [{ raw: params.parentPath, purpose: 'write' }], async (fs, [at]) => ({
        path: await fs.createFile(at!, params.name),
      })),
    'files.createDirectory': (params, asking) =>
      writing(
        'files.createDirectory',
        params,
        asking,
        [{ raw: params.parentPath, purpose: 'write' }],
        async (fs, [at]) => ({ path: await fs.createDirectory(at!, params.name, params.existing) }),
      ),
    'files.rename': (params, asking) =>
      writing(
        'files.rename',
        params,
        asking,
        [{ raw: params.path, purpose: 'write', notRoot: true }],
        async (fs, [at]) => ({ path: await fs.rename(at!, params.name) }),
      ),
    'files.copy': (params, asking) =>
      writing(
        'files.copy',
        params,
        asking,
        [
          { raw: params.path, purpose: 'read' },
          { raw: params.toFolder, purpose: 'write' },
        ],
        async (fs, [from, to]) => ({ path: await fs.copy(from!, to!, params.onConflict) }),
      ),
    'files.move': (params, asking) =>
      writing(
        'files.move',
        params,
        asking,
        [
          { raw: params.path, purpose: 'write', notRoot: true },
          { raw: params.toFolder, purpose: 'write' },
        ],
        async (fs, [from, to]) => ({ path: await fs.move(from!, to!) }),
      ),
    'files.trash': (params, asking) =>
      writing(
        'files.trash',
        params,
        asking,
        [{ raw: params.path, purpose: 'write', notRoot: true }],
        async (fs, [at]) => {
          await fs.trash(at!)
          return {}
        },
      ),
  }

  // The reads `chat.ts` declares by an absolute path, served here.
  const byPath = {
    search: (input: StudioMethodParams<'files.search'>, asking: StudioFileSystemAsking) =>
      reading(
        'files.search',
        input.rootPath,
        asking,
        (fs, at) => fs.searchFiles(asking.context.slot, { ...input, rootPath: at }),
        'fs:search-files',
        (path) => [{ ...input, rootPath: path }],
      ),
    cancelSearch: (channel: string | undefined, context: StudioRequestContext) => {
      if (!fileSystem) return unserved('files.cancelSearch')
      fileSystem.cancelFileSearch(context.slot, channel)
      return ok({} as Record<string, never>)
    },
    stat: (path: string, asking: StudioFileSystemAsking) =>
      reading('files.stat', path, asking, (fs, at) => fs.stat(at), 'fs:stat'),
    readImage: (path: string, asking: StudioFileSystemAsking) =>
      reading('files.readImage', path, asking, (fs, at) => fs.readImage(at), 'fs:read-image-data-url'),
    repoRoot: (folderPath: string, hostId: string | undefined, asking: StudioFileSystemAsking) =>
      reading('files.repoRoot', folderPath, asking, (fs, at) => fs.repoRoot(at, hostId), 'git:get-repo-root'),
  }

  /** Follow a folder for `files.watchPath`: refused as unknown, or not there, in the subscriber's terms. */
  async function watch(
    params: { path: string; includeIgnored?: boolean },
    asking: Pick<StudioFileSystemAsking, 'grant' | 'context'>,
    listener: Parameters<StudioFileSystem['watch']>[2],
  ): Promise<StudioFileSystemWatch | { ok: false; code: 'not_found' | 'unavailable'; message: string }> {
    if (!fileSystem) return { ok: false, code: 'unavailable', message: 'This Studio does not serve files.watchPath.' }
    const at = await placePath(fileSystem, params.path, asking, 'read')
    if (!at.ok) return { ok: false, code: 'not_found', message: UNKNOWN_PATH }
    // A folder on an SSH machine is not watched: its views refresh by asking again.
    if (at.machine) return { ok: false, code: 'unavailable', message: notOnMachineYet('files.watchPath') }
    return fileSystem.watch(at.path, params.includeIgnored === true, listener)
  }

  return { handlers, byPath, watch }
}

export type StudioFileSystemRouting = ReturnType<typeof createStudioFileSystemHandlers>
