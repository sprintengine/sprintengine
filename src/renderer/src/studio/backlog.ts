import {
  STUDIO_BACKLOG_CAPABILITY,
  type BacklogAddOrUpdateLinkInput,
  type BacklogCreateEpicInput,
  type BacklogCreateEpicResult,
  type BacklogDependenciesInput,
  type BacklogEnsureIdsInput,
  type BacklogEnsureIdsResult,
  type BacklogEpicColorInput,
  type BacklogEpicInput,
  type BacklogHighlightInput,
  type BacklogItemRecordInput,
  type BacklogLocationResult,
  type BacklogMockupsInput,
  type BacklogModuleMetadataInput,
  type BacklogMoveSourceInput,
  type BacklogMutationResult,
  type BacklogReadResult,
  type BacklogRemoveLinkInput,
  type BacklogRemoveRecordInput,
  type BacklogSetRootInput,
  type BacklogStatusInput,
  type BacklogTriageInput,
  type StudioBacklogEdit,
  type StudioMethod,
  type StudioMethodParams,
  type StudioMethodResult,
} from '../../../../packages/studio-protocol/src/public'
import { windowStudioClient } from './windowStudioClient'

// The window's way to a project's backlog by its folder: the Studio
// protocol's `backlog.location`, `.setRoot`, `.ensureRecords`, `.ensureIds`,
// `.edit` and `.createEpic`, over the window's own connection. The Backlog
// panel, its item sheet and context menu, the shared scan, the agent hand-off
// and the backlog location hook call these. The members keep the names the
// window has always called them by, so a caller changes only where it imports
// them from; each item change is one `backlog.edit`.

export type BacklogApi = {
  resolveBacklogLocation(workspaceRoot: string): Promise<BacklogLocationResult>
  setBacklogRoot(input: BacklogSetRootInput): Promise<BacklogLocationResult>
  ensureBacklogObjectRecords(workspaceRoot: string, items: BacklogItemRecordInput[]): Promise<BacklogReadResult>
  ensureBacklogItemIds(input: BacklogEnsureIdsInput): Promise<BacklogEnsureIdsResult>
  updateBacklogStatus(input: BacklogStatusInput): Promise<BacklogMutationResult>
  updateBacklogTriage(input: BacklogTriageInput): Promise<BacklogMutationResult>
  updateBacklogHighlight(input: BacklogHighlightInput): Promise<BacklogMutationResult>
  addOrUpdateBacklogLink(input: BacklogAddOrUpdateLinkInput): Promise<BacklogMutationResult>
  removeBacklogLink(input: BacklogRemoveLinkInput): Promise<BacklogMutationResult>
  updateBacklogModuleMetadata(input: BacklogModuleMetadataInput): Promise<BacklogMutationResult>
  moveBacklogObjectSource(input: BacklogMoveSourceInput): Promise<BacklogMutationResult>
  removeBacklogObjectRecord(input: BacklogRemoveRecordInput): Promise<BacklogMutationResult>
  updateBacklogEpic(input: BacklogEpicInput): Promise<BacklogMutationResult>
  updateBacklogEpicColor(input: BacklogEpicColorInput): Promise<BacklogMutationResult>
  updateBacklogDependencies(input: BacklogDependenciesInput): Promise<BacklogMutationResult>
  updateBacklogMockups(input: BacklogMockupsInput): Promise<BacklogMutationResult>
  createBacklogEpic(input: BacklogCreateEpicInput): Promise<BacklogCreateEpicResult>
}

const UNSERVED = 'This Studio does not serve its backlogs to this window.'

function randomId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

async function call<M extends StudioMethod>(method: M, params: StudioMethodParams<M>): Promise<StudioMethodResult<M>> {
  const client = await windowStudioClient()
  if (!client.supports(STUDIO_BACKLOG_CAPABILITY)) throw new Error(UNSERVED)
  return client.request(method, params)
}

/** A write, under a command id of its own. */
function act<M extends StudioMethod>(
  method: M,
  params: Omit<StudioMethodParams<M>, 'commandId'>,
): Promise<StudioMethodResult<M>> {
  return call(method, { ...params, commandId: randomId() } as StudioMethodParams<M>)
}

/** One item's change, as the panel names the item. */
function edit(input: { workspaceRoot: string; relativePath: string }, change: StudioBacklogEdit) {
  return act('backlog.edit', { workspaceRoot: input.workspaceRoot, relativePath: input.relativePath, edit: change })
}

export const backlogApi: BacklogApi = {
  resolveBacklogLocation: (workspaceRoot) => call('backlog.location', { workspaceRoot }),
  setBacklogRoot: ({ workspaceRoot, root }) => act('backlog.setRoot', { workspaceRoot, root }),
  ensureBacklogObjectRecords: (workspaceRoot, items) => act('backlog.ensureRecords', { workspaceRoot, items }),
  ensureBacklogItemIds: ({ workspaceRoot, items }) => act('backlog.ensureIds', { workspaceRoot, items }),
  updateBacklogStatus: (input) => edit(input, { kind: 'status', status: input.status }),
  updateBacklogTriage: (input) =>
    edit(input, {
      kind: 'triage',
      ...(input.difficulty !== undefined ? { difficulty: input.difficulty } : {}),
      ...(input.criticality !== undefined ? { criticality: input.criticality } : {}),
      ...(input.risk !== undefined ? { risk: input.risk } : {}),
    }),
  updateBacklogHighlight: (input) => edit(input, { kind: 'highlight', starred: input.starred, color: input.color }),
  addOrUpdateBacklogLink: (input) =>
    edit(input, { kind: 'addLink', link: input.link, ...(input.status ? { status: input.status } : {}) }),
  removeBacklogLink: (input) => edit(input, { kind: 'removeLink', linkId: input.linkId }),
  updateBacklogModuleMetadata: (input) =>
    edit(input, { kind: 'moduleMetadata', moduleId: input.moduleId, value: input.value }),
  moveBacklogObjectSource: (input) => edit(input, { kind: 'moveSource', nextRelativePath: input.nextRelativePath }),
  removeBacklogObjectRecord: (input) => edit(input, { kind: 'removeRecord' }),
  updateBacklogEpic: (input) => edit(input, { kind: 'epic', epic: input.epic }),
  updateBacklogEpicColor: (input) => edit(input, { kind: 'epicColor', color: input.color }),
  updateBacklogDependencies: (input) => edit(input, { kind: 'dependencies', dependsOn: input.dependsOn }),
  updateBacklogMockups: (input) => edit(input, { kind: 'mockups', mockups: input.mockups }),
  createBacklogEpic: ({ workspaceRoot, title }) => act('backlog.createEpic', { workspaceRoot, title }),
}
