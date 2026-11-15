// The memory graph and its activity feed: the Studio protocol's shapes
// (`memory.*`, `memoryActivity.*`). ../electron-api.ts re-exports everything here.

export type {
  MemoryGraphNodeKind,
  MemoryGraphNode,
  MemoryGraphEdge,
  MemoryUnresolvedLink,
  MemoryRootStatus,
  MemoryGraphIndexResult,
  MemoryPreviewResult,
  MemoryActivityEvent,
  MemoryActivitySynapse,
  MemoryActivityStatus,
  MemoryActivityInstallResult,
  MemoryActivityUninstallResult,
  MemoryActivitySynapsesPayload,
} from '../../../packages/studio-protocol/src/public'
