import type {
  BacklogCreateEpicResult,
  BacklogEnsureIdsItemInput,
  BacklogEnsureIdsResult,
  BacklogItemRecordInput,
  BacklogLocationResult,
  BacklogMutationResult,
  BacklogReadResult,
  StudioBacklogEdit,
} from '../../../packages/studio-protocol/src/public'
import {
  addOrUpdateBacklogLink,
  createBacklogEpic,
  ensureBacklogItemIds,
  ensureBacklogObjectRecords,
  moveBacklogObjectSource,
  removeBacklogLink,
  removeBacklogObjectRecord,
  resolveBacklogLocation,
  setBacklogRoot,
  updateBacklogDependencies,
  updateBacklogEpic,
  updateBacklogEpicColor,
  updateBacklogHighlight,
  updateBacklogMockups,
  updateBacklogModuleMetadata,
  updateBacklogStatus,
  updateBacklogTriage,
} from '../../main/backlog-service'

// A project's backlog by its folder, as the desktop's own windows read and
// write it (`backlog.location`, `.setRoot`, `.ensureRecords`, `.ensureIds`,
// `.edit`, `.createEpic`): the backlog service's own calls, which read and
// write the item files and the object store beside them in that folder. Who
// may name the folder is the router's, before this is reached.

export type StudioBacklogFolders = {
  location(workspaceRoot: string): Promise<BacklogLocationResult>
  setRoot(workspaceRoot: string, root: string | null): Promise<BacklogLocationResult>
  ensureRecords(workspaceRoot: string, items: BacklogItemRecordInput[]): Promise<BacklogReadResult>
  ensureIds(workspaceRoot: string, items: BacklogEnsureIdsItemInput[]): Promise<BacklogEnsureIdsResult>
  edit(workspaceRoot: string, relativePath: string, edit: StudioBacklogEdit): Promise<BacklogMutationResult>
  createEpic(workspaceRoot: string, title: string): Promise<BacklogCreateEpicResult>
}

/** One item's change, by the service call that makes it. */
function edited(workspaceRoot: string, relativePath: string, edit: StudioBacklogEdit): Promise<BacklogMutationResult> {
  const item = { workspaceRoot, relativePath }
  switch (edit.kind) {
    case 'status':
      return updateBacklogStatus({ ...item, status: edit.status })
    case 'triage': {
      const { kind: _kind, ...triage } = edit
      return updateBacklogTriage({ ...item, ...triage })
    }
    case 'highlight':
      return updateBacklogHighlight({ ...item, starred: edit.starred, color: edit.color })
    case 'addLink':
      return addOrUpdateBacklogLink({ ...item, link: edit.link, ...(edit.status ? { status: edit.status } : {}) })
    case 'removeLink':
      return removeBacklogLink({ ...item, linkId: edit.linkId })
    case 'moduleMetadata':
      return updateBacklogModuleMetadata({ ...item, moduleId: edit.moduleId, value: edit.value })
    case 'moveSource':
      return moveBacklogObjectSource({ ...item, nextRelativePath: edit.nextRelativePath })
    case 'removeRecord':
      return removeBacklogObjectRecord(item)
    case 'epic':
      return updateBacklogEpic({ ...item, epic: edit.epic })
    case 'epicColor':
      return updateBacklogEpicColor({ ...item, color: edit.color })
    case 'dependencies':
      return updateBacklogDependencies({ ...item, dependsOn: edit.dependsOn })
    case 'mockups':
      return updateBacklogMockups({ ...item, mockups: edit.mockups })
  }
}

export function createStudioBacklogFolders(): StudioBacklogFolders {
  return {
    location: (workspaceRoot) => resolveBacklogLocation(workspaceRoot),
    setRoot: (workspaceRoot, root) => setBacklogRoot({ workspaceRoot, root }),
    ensureRecords: (workspaceRoot, items) => ensureBacklogObjectRecords(workspaceRoot, items),
    ensureIds: (workspaceRoot, items) => ensureBacklogItemIds({ workspaceRoot, items }),
    edit: edited,
    createEpic: (workspaceRoot, title) => createBacklogEpic({ workspaceRoot, title }),
  }
}
