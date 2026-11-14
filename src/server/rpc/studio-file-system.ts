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
import { expandHomePath } from '../../main/home-path'
import { confineToRoots } from '../../main/studio-rpc/studio-file-confinement'
import { isMachinePath } from '../../shared/machine-paths'
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
// A path on an SSH machine (`ssh://<id>/…`) is never this machine's: that
// machine's own Studio answers for it, and the window asks it there
// (design-wsl-ssh-direct PR 2). Here it is refused, in words to an owner and
// as unknown to anyone else, never resolved on this disk.

export type StudioFileSystemAsking = {
  grant: StudioGrant
  context: StudioRequestContext
  voice: { failed(code: 'unavailable', detail: string | undefined, context: string): unknown }
}

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
  /** The first answer to a command id is every retry's. */
  once: Kept
  /** A client's command id, namespaced by the client. */
  runtimeId(grant: StudioGrant, commandId: string): string
}

export const UNKNOWN_PATH = 'That path is not in a folder Studio knows.'
export const ON_ANOTHER_MACHINE = 'That path is on an SSH machine: its own Studio answers for it.'
const ROOT_ITSELF = 'A workspace’s own folder is not renamed, moved or removed from here.'

const refuse = <C extends string>(code: C, message: string): Refused<C> => ({ ok: false, error: { code, message } })
const ok = <T>(result: T): { ok: true; result: T } => ({ ok: true, result })

/** Where a path the asker named is: its path here; or none, and whether that is because it is on another machine. */
export type Placed = { ok: true; path: string } | { ok: false; elsewhere?: true }

/** The refusal for a path that could not be placed. */
export function unplaced(at: { ok: false; elsewhere?: true }): Refused<'not_found' | 'unavailable'> {
  return at.elsewhere ? refuse('unavailable', ON_ANOTHER_MACHINE) : refuse('not_found', UNKNOWN_PATH)
}

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
  if (isMachinePath(raw)) return anyPath ? { ok: false, elsewhere: true } : { ok: false }
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

  /** Read about one path: refused when the asker may not name it, or when it is on another machine. */
  async function reading<T>(
    method: string,
    raw: string,
    asking: StudioFileSystemAsking,
    here: (fs: StudioFileSystem, path: string) => Promise<T>,
  ): Promise<{ ok: true; result: T } | Refused<'unavailable' | 'not_found'>> {
    if (!fileSystem) return unserved(method)
    const at = await placePath(fileSystem, raw, asking, 'read')
    if (!at.ok) return unplaced(at)
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
          if (!at.ok) return unplaced(at)
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
      if (!at.ok) return unplaced(at)
      return ok({ entries: await fileSystem.listDirectory(at.path) })
    },
    'files.readText': async ({ path }, asking) => {
      if (!fileSystem) return unserved('files.readText')
      const at = await placePath(fileSystem, path, asking, 'read')
      if (!at.ok) return unplaced(at)
      // A path held to known folders is its checked real path: read it without following a link put there since.
      return ok({ text: await fileSystem.readText(at.path, { confined: !namesAnyPath(asking) }) })
    },
    'files.exists': async ({ path }, asking) => {
      if (!fileSystem) return unserved('files.exists')
      const at = await placePath(fileSystem, path, asking, 'read')
      // Never there, as asked here: a path on another machine is that machine's to say.
      if (!at.ok) return ok({ exists: false })
      return ok({ exists: await fileSystem.exists(at.path) })
    },
    'files.checkWorkspaceFolder': ({ path }, asking) =>
      reading('files.checkWorkspaceFolder', path, asking, (fs, at) => fs.checkWorkspaceFolder(at)),
    'files.projectLogo': async ({ folderPath }, asking) => {
      if (!fileSystem) return unserved('files.projectLogo')
      const at = await placePath(fileSystem, folderPath, asking, 'read')
      if (!at.ok) return ok({ logo: null })
      return ok({ logo: await fileSystem.projectLogo(at.path) })
    },
    'files.projectIcon': async ({ path }, asking) => {
      if (!fileSystem) return unserved('files.projectIcon')
      const at = await placePath(fileSystem, path, asking, 'read')
      if (!at.ok) return ok({ logo: null })
      return ok({ logo: await fileSystem.projectIcon(at.path) })
    },
    'files.searchContent': ({ rootPath, query, limit }, asking) =>
      reading('files.searchContent', rootPath, asking, (fs, at) =>
        fs.searchContent(asking.context.slot, { rootPath: at, query, ...(limit === undefined ? {} : { limit }) }),
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
        const owner = namesAnyPath(asking)
        const roots = owner ? (params.roots ?? []) : await fs.writableRoots()
        await fs.writeText(path!, params.text, roots, owner)
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
        async (fs, [at]) => ({ path: await fs.rename(at!, params.name, namesAnyPath(asking)) }),
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
        async (fs, [from, to]) => ({ path: await fs.copy(from!, to!, params.onConflict, namesAnyPath(asking)) }),
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
        async (fs, [from, to]) => ({ path: await fs.move(from!, to!, namesAnyPath(asking)) }),
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
      reading('files.search', input.rootPath, asking, (fs, at) =>
        fs.searchFiles(asking.context.slot, { ...input, rootPath: at }),
      ),
    cancelSearch: (channel: string | undefined, context: StudioRequestContext) => {
      if (!fileSystem) return unserved('files.cancelSearch')
      fileSystem.cancelFileSearch(context.slot, channel)
      return ok({} as Record<string, never>)
    },
    stat: (path: string, asking: StudioFileSystemAsking) =>
      reading('files.stat', path, asking, (fs, at) => fs.stat(at)),
    readImage: (path: string, asking: StudioFileSystemAsking) =>
      reading('files.readImage', path, asking, (fs, at) => fs.readImage(at)),
    repoRoot: (folderPath: string, hostId: string | undefined, asking: StudioFileSystemAsking) =>
      reading('files.repoRoot', folderPath, asking, (fs, at) => fs.repoRoot(at, hostId)),
  }

  /** Follow a folder for `files.watchPath`: refused as unknown, or not there, in the subscriber's terms. */
  async function watch(
    params: { path: string; includeIgnored?: boolean },
    asking: Pick<StudioFileSystemAsking, 'grant' | 'context'>,
    listener: Parameters<StudioFileSystem['watch']>[2],
  ): Promise<StudioFileSystemWatch | { ok: false; code: 'not_found' | 'unavailable'; message: string }> {
    if (!fileSystem) return { ok: false, code: 'unavailable', message: 'This Studio does not serve files.watchPath.' }
    const at = await placePath(fileSystem, params.path, asking, 'read')
    if (!at.ok) return { ok: false, ...unplaced(at).error }
    return fileSystem.watch(at.path, params.includeIgnored === true, listener)
  }

  return { handlers, byPath, watch }
}

export type StudioFileSystemRouting = ReturnType<typeof createStudioFileSystemHandlers>
