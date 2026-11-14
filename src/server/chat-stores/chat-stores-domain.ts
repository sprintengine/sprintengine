import { join } from 'node:path'

import type {
  ConversationImportInput,
  ConversationImportResult,
  ConversationImportScanResult,
  UsageLimitResumeState,
  UsageLimitResumeUpdate,
  UsageLimitsState,
  UsageReportRequest,
  UsageReportResult,
  UsageWireAnswer,
  UsageWireArgs,
} from '../../../packages/studio-protocol/src/public'
import {
  resolveLocalMachineIdentity,
  resolveMachineIdentity,
  shortHostName,
  type MachineMarkSettings,
} from '../../shared/machine-identity'
import type { TailnetMeshService } from '../../main/automation/tailnet/tailnet-mesh-service'
import type { ConversationImportService } from '../../main/conversation-import/conversation-import-service'
import { createUsageFleet, encodeUsageAnswer, fleetRowsOf, type UsageFleet } from '../../main/usage/usage-mesh'
import { appUsageService, type UsageService, type UsageServiceWorkspace } from '../../main/usage/usage-service'
import { createUsageLimitsDiskCache, USAGE_LIMITS_CACHE_FILE } from '../../main/usage-limits/disk-cache'
import type { UsageLimitResumer } from '../../main/usage-limits/resume'
import { usageLimitsStore, type UsageLimitsStore } from '../../main/usage-limits/store'

// What the Studio keeps beside its chats, for every chat at once, as the
// Studio protocol serves it (`usageLimits.*`, `usageLimitResumes.*`,
// `usage.report`, `conversationImport.*`): one domain
// the RPC router answers from, for the app's own windows and every other
// client alike. Each store is the core's; this is the one place that reads
// the usage limits' cache file, so there is one writer of it.

export type StudioChatStores = {
  /** The limits as last heard; the first read waits for the cache, so a window opened at launch has the last run's bars. */
  usageLimits(): Promise<UsageLimitsState>
  onUsageLimitsChanged(listener: (state: UsageLimitsState) => void): () => void
  usageLimitResumes(): UsageLimitResumeState
  updateUsageLimitResume(update: UsageLimitResumeUpdate): UsageLimitResumeState
  onUsageLimitResumesChanged(listener: (state: UsageLimitResumeState) => void): () => void
  /** Never rejects: a failure is `{ ok: false, message }`. */
  usageReport(request: UsageReportRequest): Promise<UsageReportResult>
  /** This machine's own rows over a window, for a paired desktop's dashboard (`usage.rows`). */
  usageRows(args: UsageWireArgs): Promise<UsageWireAnswer>
  scanImports(): Promise<ConversationImportScanResult>
  importConversations(input: ConversationImportInput): Promise<ConversationImportResult>
  /** Stop following the limits and let the cache's last write land. */
  dispose(): Promise<void>
}

export type StudioChatStoresDeps = {
  resumes: UsageLimitResumer
  imports: ConversationImportService
  /** The app's per-user data folder: the limits' cache, and the usage scan's cache and price list under `usage/`. */
  dataDir: () => string
  /** Open workspaces with their agents, so a chat's transcript is read where it runs. */
  getWorkspaces: () => readonly UsageServiceWorkspace[]
  /** The machines paired over the tailnet, whose usage is counted with this one's; absent where there is no mesh. */
  mesh?: () => Pick<TailnetMeshService, 'listConnections' | 'readUsage'> | null
  /** This machine's host name, and the person's kinds and colours for machines (Settings › Machines). */
  hostName?: () => string
  machineMarks?: () => MachineMarkSettings | null | undefined
  /** Overrides (tests): the limits' store, and the report. */
  limits?: UsageLimitsStore
  usage?: Pick<UsageFleet, 'report'>
  rows?: Pick<UsageService, 'peerRows'>
  /** Whether to keep the limits in their cache file; tests turn it off. */
  cacheLimits?: boolean
}

function words(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createStudioChatStores(deps: StudioChatStoresDeps): StudioChatStores {
  const limits = deps.limits ?? usageLimitsStore()
  // The cache's write is debounced and not flushed at quit: a reading lost to
  // a quit in that second is replaced by the first turn of the next run.
  const cache =
    deps.cacheLimits === false
      ? null
      : createUsageLimitsDiskCache({ file: join(deps.dataDir(), USAGE_LIMITS_CACHE_FILE) })
  const loaded = cache ? cache.attach(limits).catch(() => undefined) : Promise.resolve()

  let fleet = deps.usage ?? null
  const usage = (): Pick<UsageFleet, 'report'> =>
    (fleet ??= createUsageFleet({
      service: appUsageService({ dataDir: deps.dataDir, getWorkspaces: deps.getWorkspaces }),
      dataDir: deps.dataDir,
      peers: () => deps.mesh?.()?.listConnections() ?? [],
      askPeer: async (connectionId, args, options) => {
        const mesh = deps.mesh?.()
        if (!mesh) return { ok: false, status: 'offline', message: 'Remote control is not running here.' }
        return mesh.readUsage({ connectionId, args, timeoutMs: options.timeoutMs })
      },
      localMachine: () => {
        const hostName = deps.hostName?.() ?? ''
        const own = resolveLocalMachineIdentity(hostName, deps.machineMarks?.())
        return { label: shortHostName(hostName) || 'This machine', kind: own.kind, color: own.colour }
      },
      pairedMachine: (machineName) => {
        const identity = resolveMachineIdentity({ kind: 'paired', name: machineName }, deps.machineMarks?.())
        return { kind: identity?.kind ?? 'desktop', color: identity?.colour ?? 'neutral' }
      },
    }))

  return {
    usageLimits: async () => {
      await loaded
      return limits.state()
    },
    onUsageLimitsChanged: (listener) => limits.onChanged(listener),
    usageLimitResumes: () => deps.resumes.state(),
    updateUsageLimitResume: (update) => deps.resumes.update(update),
    onUsageLimitResumesChanged: (listener) => deps.resumes.onChanged(listener),
    usageReport: async (request) => {
      try {
        return await usage().report(request)
      } catch (error) {
        return { ok: false, message: words(error) }
      }
    },
    usageRows: async (args) => {
      const read = await (
        deps.rows ?? appUsageService({ dataDir: deps.dataDir, getWorkspaces: deps.getWorkspaces })
      ).peerRows({ from: args.from, to: args.to, refresh: args.refresh === true, wait: args.wait === true })
      return encodeUsageAnswer({
        rows: fleetRowsOf(read.rows),
        scannedAt: read.scannedAt,
        scanning: read.scanning,
        sources: read.sources,
      })
    },
    scanImports: async () => {
      try {
        return await deps.imports.scan()
      } catch (error) {
        return { ok: false, message: words(error) }
      }
    },
    importConversations: async (input) => {
      try {
        return await deps.imports.importSessions(input)
      } catch (error) {
        return { ok: false, message: words(error) }
      }
    },
    dispose: async () => {
      await cache?.dispose()
    },
  }
}
