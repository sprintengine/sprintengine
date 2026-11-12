// Part of the IPC contract: workspace skills, skill sources and skill plugins.
// ../electron-api.ts re-exports everything here.

export type {
  AgentSkillSkipReason,
  AgentSkillTarget,
  AgentSkillTargetStatus,
  AgentSkillWriteInput,
  AgentSkillWriteResult,
  InstalledPluginRecord,
  SkillAddLocalSourceInput,
  SkillAddSourceInput,
  SkillAddSourceResult,
  SkillInstallInput,
  SkillInstallOutcome,
  SkillInstallScope,
  SkillInstalledPluginsInput,
  SkillInstalledPluginsOutcome,
  SkillPluginInstallHarness,
  SkillPluginInstallInput,
  SkillPluginInstallOutcome,
  SkillPluginScanLinkedInput,
  SkillPluginScanLinkedOutcome,
  SkillPluginUninstallInput,
  SkillPluginUninstallOutcome,
  SkillPopularReposOutcome,
  SkillReadFileInput,
  SkillReadFileResult,
  SkillRemoveSourceInput,
  SkillRemoveSourceResult,
  SkillScanInput,
  SkillScanOutcome,
  SkillSearchInput,
  SkillSearchOutcome,
  SkillSourceUpdateCheck,
  SkillSourceUpdateEntry,
  SkillSourcesResult,
  SkillSyncFailure,
  SkillSyncSourceInput,
  SkillSyncSourceOutcome,
  SkillUninstallInput,
  SkillUninstallOutcome,
  WorkspaceSkill,
  WorkspaceSkillInstallState,
  WorkspaceSkillSource,
  WorkspaceSkillsListInput,
  WorkspaceSkillsListResult,
} from '../../../packages/studio-protocol/src/public'

// Attaching a skill to the agents that can use it, and removing it again.
// src/main/agent-skill-installer.ts owns the behaviour; these are the IPC
// envelopes.

// Plugins from sources (backlog/2026-09-05-plugin-sources.md). A source's
// plugins ride in its scan; these are the calls that read a linked plugin,
// install one into a workspace, take it out again, and list what is in.
