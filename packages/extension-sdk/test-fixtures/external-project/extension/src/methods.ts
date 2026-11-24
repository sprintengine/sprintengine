// The contract between the worker and the surfaces: what the worker declares
// with `registerMethods` and what a surface calls through `studio.methods`.

import type { ExtensionCommandContext, ModuleMethodParsed } from '@sprintengine/extension-sdk'

export type Outlook = { city: string; summary: string; refreshedAt: number }

export type WeatherMethods = {
  readOutlook: { access: 'read'; params: Record<string, never>; result: Outlook }
  // A command without an `action` runs the worker method of its id, with the
  // command's context as params.
  'forecast.refresh': {
    access: 'operate'
    params: ExtensionCommandContext
    result: { refreshed: number }
    errors: 'no_workspace'
  }
}

export function readNothing(): ModuleMethodParsed<Record<string, never>> {
  return { ok: true, params: {} }
}

export function readCommandContext(value: unknown): ModuleMethodParsed<ExtensionCommandContext> {
  const record = (value ?? {}) as Partial<ExtensionCommandContext>
  const where = record.where
  if (
    where !== 'palette' &&
    where !== 'topBar' &&
    where !== 'backlog.item' &&
    where !== 'file' &&
    where !== 'notification'
  ) {
    return { ok: false, message: 'A command runs with a context that says where it was run.' }
  }
  const workspaceId = typeof record.workspaceId === 'string' ? record.workspaceId : null
  const filePaths = Array.isArray(record.filePaths)
    ? record.filePaths.filter((path): path is string => typeof path === 'string')
    : undefined
  return { ok: true, params: { where, workspaceId, ...(filePaths ? { filePaths } : {}) } }
}
