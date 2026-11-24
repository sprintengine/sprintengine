import type { WorkspaceCreateRequest, WorkspaceCreateResult } from '../../../main/workspace-registry-service'
import type { ExtensionInvoker } from '../../../main/module-host/extension-invocation'
import { workspaceProjectRootOf } from '../../../shared/worktree-paths'
import { ExtensionHookDenied, runExtensionHook, type ExtensionHooks } from './extension-hooks'

// A workspace an agent's `workspace.create` or an extension asks for meets
// `workspace.create.before` (which may rename or refuse it) and `.after`. A
// new chat's own workspace is hooked where the chat is launched
// (conversation-launch-service.ts).

type Created = { ok: true; result: WorkspaceCreateResult } | { ok: false; reason: string; message: string }

export async function createWorkspaceWithHooks(
  hooks: ExtensionHooks | null | undefined,
  invoker: () => ExtensionInvoker,
  request: WorkspaceCreateRequest,
  create: (request: WorkspaceCreateRequest) => Created,
): Promise<Created> {
  let next = request
  try {
    const hooked = await runExtensionHook(
      hooks,
      'workspace.create.before',
      {
        for: 'workspace',
        name: request.name?.trim() || null,
        folderPath: request.folderPath ?? null,
        project: workspaceProjectRootOf({ folderPath: request.folderPath ?? null, worktree: request.worktree ?? null }),
        worktree: Boolean(request.worktree),
        // Its worktree, when it has one, exists already: a hook's change to
        // either is not taken.
        branch: request.worktree?.branch ?? null,
        base: request.worktree?.baseRef ?? null,
      },
      invoker,
    )
    if (hooked.name !== null && hooked.name !== (request.name?.trim() || null)) next = { ...request, name: hooked.name }
  } catch (error) {
    if (error instanceof ExtensionHookDenied) return { ok: false, reason: error.code, message: error.message }
    throw error
  }
  const created = create(next)
  if (created.ok && hooks?.wants('workspace.create.after'))
    hooks.notify(
      'workspace.create.after',
      {
        for: 'workspace',
        workspaceId: created.result.workspace.id,
        name: created.result.workspace.name ?? next.name ?? '',
        folderPath: created.result.workspace.folderPath ?? null,
        project: workspaceProjectRootOf(created.result.workspace),
        worktree: Boolean(created.result.workspace.worktree),
        branch: created.result.workspace.worktree?.branch ?? null,
        base: created.result.workspace.worktree?.baseRef ?? null,
      },
      invoker(),
    )
  return created
}
