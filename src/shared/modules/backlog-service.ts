// The module-facing Backlog write contract: what a module's `entry.main`
// (getBacklogService) and renderer (the RendererHost Backlog write methods)
// reach, served by main/module-host/module-backlog.ts over the app's own
// Backlog service. The SDK mirrors these shapes by hand and the drift guard
// pins the two together. Node-free and type-only, so both tsconfig projects
// can import it.

import type {
  StudioModuleBacklogAnswer,
  StudioModuleBacklogCreated,
  StudioModuleBacklogCreateInput,
  StudioModuleBacklogErrorCode,
  StudioModuleBacklogLinkInput,
  StudioModuleBacklogLocation,
  StudioModuleBacklogTriageInput,
} from '../../../packages/studio-protocol/src/public'
import type { BacklogItem, BacklogItemLink, BacklogItemStatus } from '../backlog/scan'

// The wire shapes are the Studio protocol's (`module-services.ts`): a module's
// window half sends these calls to its server, so they are defined there once.
export type ModuleBacklogErrorCode = StudioModuleBacklogErrorCode
export type ModuleBacklogResult<T extends object = object> = StudioModuleBacklogAnswer<T>
export type ModuleBacklogLocation = StudioModuleBacklogLocation
export type ModuleBacklogTriageInput = StudioModuleBacklogTriageInput
export type ModuleBacklogCreateInput = StudioModuleBacklogCreateInput
export type ModuleBacklogCreated = StudioModuleBacklogCreated
// A link is the scan's link the caller owns, in the form the SDK mirrors
// exactly; the protocol carries the same shape written out, and the two may
// not drift apart.
export type ModuleBacklogLinkInput = Omit<BacklogItemLink, 'moduleId'> & { moduleId?: string }
type SameShape<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const linkShape: SameShape<ModuleBacklogLinkInput, StudioModuleBacklogLinkInput> = true
void linkShape

// `list` hands out the scan's own items, which carry more than the SDK's
// published `BacklogItemView` (the drift guard checks the one satisfies the
// other); everything else is restated exactly.
export type ModuleBacklogService = {
  list(workspaceId: string): Promise<ModuleBacklogResult<{ items: BacklogItem[] }>>
  getLocation(workspaceId: string): Promise<ModuleBacklogResult<{ location: ModuleBacklogLocation }>>
  create(workspaceId: string, input: ModuleBacklogCreateInput): Promise<ModuleBacklogResult<ModuleBacklogCreated>>
  updateStatus(workspaceId: string, itemId: string, status: BacklogItemStatus): Promise<ModuleBacklogResult>
  updateTriage(workspaceId: string, itemId: string, triage: ModuleBacklogTriageInput): Promise<ModuleBacklogResult>
  addLink(workspaceId: string, itemId: string, link: ModuleBacklogLinkInput): Promise<ModuleBacklogResult>
  updateModuleMetadata(workspaceId: string, itemId: string, value: unknown): Promise<ModuleBacklogResult>
}

// What the host provides under 'backlog.module-service': the service with the
// calling module's id first, which the SDK helper closes over.
export type ModuleBacklogRegistry = {
  [K in keyof ModuleBacklogService]: (
    moduleId: string,
    ...args: Parameters<ModuleBacklogService[K]>
  ) => ReturnType<ModuleBacklogService[K]>
}

export type BacklogWatchError = {
  code: 'workspace_folder_missing' | 'unknown_workspace' | 'scan_failed'
  message: string
}

export type BacklogWatchOptions = {
  onError?: (error: BacklogWatchError) => void
}
