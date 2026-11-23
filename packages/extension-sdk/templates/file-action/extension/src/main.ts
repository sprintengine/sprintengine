import {
  getBacklogService,
  type ExtensionCommandContext,
  type MainHost,
  type ModuleMethodParsed,
} from '@sprintengine/extension-sdk'

// extension.json declares the command "Add to Backlog" and puts it in the
// Files tree's menu (`contributes.menus`, where "file"). The command has no
// `action`, so running it calls this worker's method of the same name, an
// `operate` method, with what it was picked on: the workspace and the paths,
// relative to the workspace's folder. Writing the Backlog needs
// "backlog:operate", of the extension and of whoever runs the command.

export type FileMethods = {
  'add-to-backlog': {
    access: 'operate'
    params: AddRequest
    result: { itemId: string }
  }
}

export type AddRequest = { workspaceId: string; filePaths: string[] }

export function readAddRequest(value: unknown): ModuleMethodParsed<AddRequest> {
  const context = (value ?? {}) as Partial<ExtensionCommandContext>
  if (typeof context.workspaceId !== 'string' || context.workspaceId === '') {
    return { ok: false, message: 'Run it from the Files tree.' }
  }
  const paths = Array.isArray(context.filePaths)
    ? context.filePaths.filter((path): path is string => typeof path === 'string' && path !== '')
    : []
  if (paths.length === 0) return { ok: false, message: 'Pick at least one file.' }
  return { ok: true, params: { workspaceId: context.workspaceId, filePaths: paths } }
}

/** The item's title: the file, or how many. */
export function itemTitle(paths: readonly string[]): string {
  return paths.length === 1 ? `Look at ${paths[0]}` : `Look at ${paths.length} files`
}

export function activate(studio: MainHost): void {
  studio.registerMethods<FileMethods>({
    'add-to-backlog': {
      access: 'operate',
      params: readAddRequest,
      handler: async (request) => {
        const created = await getBacklogService(studio).create(request.workspaceId, {
          title: itemTitle(request.filePaths).slice(0, 120),
          body: request.filePaths.map((path) => `- \`${path}\``).join('\n'),
        })
        return created.ok
          ? { ok: true, result: { itemId: created.id } }
          : { ok: false, code: created.code, message: created.message }
      },
    },
  })
}
