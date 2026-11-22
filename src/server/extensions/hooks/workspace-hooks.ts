import type { WorkspaceCreateRequest, WorkspaceCreateResult } from '../../../main/workspace-registry-service'
import type { ExtensionInvoker } from '../../../main/module-host/extension-invocation'
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
        worktree: Boolean(request.worktree),
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
        worktree: Boolean(created.result.workspace.worktree),
      },
      invoker(),
    )
  return created
}
