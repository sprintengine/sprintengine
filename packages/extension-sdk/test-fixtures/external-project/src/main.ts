// The worker: `main` in extension.json, loaded with Node's require, compiled
// against the packed SDK tarball only. It serves the declared methods, the
// command without an `action`, and the declared MCP tool, and it still
// declares its poller sidecar here (background workers come later).

import {
  createServiceToken,
  getCompanionAgentsService,
  getConversationService,
  getGitHubService,
  getModuleStorage,
  getScheduledAgentsService,
  getSecretsService,
  WorkspaceContextToken,
  type ExtensionActivate,
  type MainHost,
  type McpToolRegistration,
  type ModuleConversationEvent,
  type ModuleMethodParsed,
} from '@sprintengine/extension-sdk'

import { readCommandContext, readNothing, type Outlook, type WeatherMethods } from './methods'

const forecastService = createServiceToken<{ refresh(): Promise<void> }>('weather-deck.forecast')

// The tool extension.json declares under contributes.mcpTools. Its
// description and access there are what agents see.
const forecastTool: McpToolRegistration = {
  name: 'weather_deck_forecast',
  description: 'Read the current forecast for a city.',
  mutates: false,
  inputSchema: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City to forecast.' },
    },
    required: ['city'],
    additionalProperties: false,
  },
  handler: async (args) => {
    const city = typeof args.city === 'string' ? args.city.trim() : ''
    if (!city) {
      return {
        content: [{ type: 'text', text: 'invalid_arguments: "city" must be a city name.' }],
        structuredContent: { ok: false, error: { code: 'invalid_arguments', message: '"city" must be a city name.' } },
        isError: true,
      }
    }
    const structured = { city, summary: 'clear' }
    return {
      content: [{ type: 'text', text: JSON.stringify(structured) }],
      structuredContent: structured,
    }
  },
}

// Every method reads its params; these take what the window sends as it is
// and check it in the handler. Each answers what its work returns.
const anything = (value: unknown): ModuleMethodParsed<unknown> => ({ ok: true, params: value })
function answering<R>(work: (params: unknown) => Promise<R>) {
  return async (params: unknown) => ({ ok: true as const, result: await work(params) })
}

const outlook: Outlook = { city: 'Dublin', summary: 'clear', refreshedAt: 0 }

export function activate(studio: MainHost): void {
  studio.registerMethods<WeatherMethods>({
    readOutlook: { access: 'read', params: readNothing, handler: () => ({ ok: true, result: outlook }) },
    'forecast.refresh': {
      access: 'operate',
      params: readCommandContext,
      handler: (context) => {
        if (context.workspaceId === null) {
          return { ok: false, code: 'no_workspace', message: 'Open a workspace first.' }
        }
        outlook.refreshedAt += 1
        studio.emit('outlook-refreshed', outlook)
        return { ok: true, result: { refreshed: context.filePaths?.length ?? 1 } }
      },
    },
  })
  studio.provideService(forecastService, () => ({
    refresh: async () => undefined,
  }))
  studio.registerMcpTools([forecastTool])
  // The skill the forecaster chats and the scheduled refresh invoke.
  studio.registerMethods({
    forecast: {
      access: 'read',
      params: anything,
      handler: answering(async (city: unknown) => {
        if (typeof city !== 'string' || city.trim().length === 0) {
          throw new Error('weather-deck:forecast requires a city name.')
        }
        return { city, summary: 'clear' }
      }),
    },
  })
  // Workspace context from entry.main: id → root/name/mode for per-workspace
  // persistence paths. Unknown ids resolve to null, never a throw.
  studio.registerMethods({
    workspaceRoot: {
      access: 'read',
      params: anything,
      handler: answering(async (workspaceId: unknown) => {
        if (typeof workspaceId !== 'string' || workspaceId.trim().length === 0) {
          throw new Error('weather-deck:workspace-root requires a workspace id.')
        }
        const workspaces = studio.requireService(WorkspaceContextToken)
        const view = await workspaces.get(workspaceId)
        return { folderPath: view?.folderPath ?? null }
      }),
    },
  })
  // Scoped module storage composed with the workspace context: resolve the
  // root, persist under it (host-placed), read back. Declare `storage`.
  studio.registerMethods({
    savePreferences: {
      access: 'operate',
      params: anything,
      handler: answering(async (input: unknown) => {
        const { workspaceId, preferences } = (input ?? {}) as { workspaceId?: unknown; preferences?: unknown }
        if (typeof workspaceId !== 'string' || workspaceId.trim().length === 0) {
          throw new Error('weather-deck:save-preferences requires a workspace id.')
        }
        const view = await studio.requireService(WorkspaceContextToken).get(workspaceId)
        // Not-yet-resolvable (null view) is a transient state — fail the save so
        // the caller retries, rather than silently writing to a scope the data
        // would later appear "lost" from. A RESOLVED workspace without a folder
        // is genuinely folderless: its data lives in the global per-user store.
        if (!view) throw new Error(`Workspace "${workspaceId}" is not resolvable yet — retry the save.`)
        const storage = getModuleStorage(studio)
        const scope = view.folderPath ? { workspaceRoot: view.folderPath } : {}
        const saved = await storage.set({ ...scope, key: 'preferences', value: preferences ?? {} })
        if (!saved.ok) throw new Error(`${saved.code}: ${saved.message}`)
        const roundTrip = await storage.get({ ...scope, key: 'preferences' })
        if (!roundTrip.ok) throw new Error(`${roundTrip.code}: ${roundTrip.message}`)
        return { found: roundTrip.found, value: roundTrip.value }
      }),
    },
  })
  // A scheduled agent the module owns, through the scoped service: a morning
  // chat that refreshes the forecast notes with the module's skill. Idempotent:
  // a second call finds the one it made in list() and makes no other.
  studio.registerMethods({
    scheduleRefresh: {
      access: 'operate',
      params: anything,
      handler: answering(async (folderPath: unknown) => {
        if (typeof folderPath !== 'string' || folderPath.trim().length === 0) {
          throw new Error('weather-deck:schedule-refresh requires a project folder.')
        }
        const scheduled = getScheduledAgentsService(studio)
        const existing = (await scheduled.list()).find((agent) => agent.folderPath === folderPath)
        if (existing) return { created: false, id: existing.id }
        const created = await scheduled.create({
          prompt: 'Refresh the forecast notes for the watched city.',
          schedule: { cron: '0 9 * * *', timezone: 'UTC' },
          folderPath,
          hostId: null,
          cli: 'claude-code',
          cliModel: 'sonnet',
          permissionPreset: null,
          skills: [{ id: 'weather-deck-forecast', name: 'Weather Deck forecast' }],
          mcpServers: [],
          worktree: null,
        })
        if (!created.ok) throw new Error(created.message)
        return { created: true, id: created.agent.id }
      }),
    },
  })
  // Cross-surface briefing (seam proof): ONE channel that composes workspace
  // context resolution with a scoped storage round-trip — the resolved view's
  // folderPath picks the storage scope, and the stored counter survives the
  // get→set→return chain. The renderer half (below) feeds the result into
  // per-module workspace state, so the value crosses three published
  // surfaces end to end instead of each being exercised in isolation.
  studio.registerMethods({
    workspaceBriefing: {
      access: 'operate',
      params: anything,
      handler: answering(async (workspaceId: unknown) => {
        if (typeof workspaceId !== 'string' || workspaceId.trim().length === 0) {
          throw new Error('weather-deck:workspace-briefing requires a workspace id.')
        }
        const view = await studio.requireService(WorkspaceContextToken).get(workspaceId)
        if (!view) throw new Error(`Workspace "${workspaceId}" is not resolvable yet — retry the briefing.`)
        const storage = getModuleStorage(studio)
        const scope = view.folderPath ? { workspaceRoot: view.folderPath } : {}
        const read = await storage.get({ ...scope, key: 'briefing-count' })
        if (!read.ok) throw new Error(`${read.code}: ${read.message}`)
        const briefingCount = (read.found && typeof read.value === 'number' ? read.value : 0) + 1
        const wrote = await storage.set({ ...scope, key: 'briefing-count', value: briefingCount })
        if (!wrote.ok) throw new Error(`${wrote.code}: ${wrote.message}`)
        return { workspaceName: view.name, mode: view.mode, briefingCount }
      }),
    },
  })
  // Companion agent: a workspace-bound background helper that answers a
  // structured question. Exercises the SDK's CompanionAgentsService surface.
  studio.registerMethods({
    askGuide: {
      access: 'operate',
      params: anything,
      handler: answering(async (workspaceRoot: unknown) => {
        if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
          throw new Error('weather-deck:ask-guide requires a workspace root.')
        }
        const companions = getCompanionAgentsService(studio)
        const guide = companions.attach({
          workspaceId: 'weather-deck',
          agentId: 'forecast-guide',
          name: 'Forecast Guide',
          workspaceRoot,
          systemPrompt: 'You summarize the forecast as strict JSON.',
        })
        guide.onStatus((status) => void status)
        const summary = await guide.runStructured<{ outlook: string }>({
          prompt: 'Summarize today as {"outlook": string}.',
          retries: 1,
          // The default, said out loud: the guide answers from the prompt alone.
          tools: 'none',
          validate: (raw) => {
            const record = raw as { outlook?: unknown }
            return typeof record.outlook === 'string'
              ? { ok: true, value: { outlook: record.outlook } }
              : { ok: false, errors: ['outlook must be a string'] }
          },
        })
        guide.dispose()
        return summary
      }),
    },
  })
  // The module-owned event stream: the subscribe verb the
  // declared methods do not have. `emit` stamps this module's identity,
  // so only this module's renderer subscribers see it. Nothing is replayed, so
  // the `readOutlook` method stays the way a late panel reads the current value —
  // the event only says "read it again".
  studio.registerMethods({
    refreshOutlook: {
      access: 'operate',
      params: anything,
      handler: answering(async (city: unknown) => {
        const name = typeof city === 'string' ? city.trim() : ''
        if (!name) throw new Error('weather-deck:refresh-outlook requires a city name.')
        const refreshed = { city: name, summary: 'clear', refreshedAt: 0 }
        studio.emit('outlook-refreshed', refreshed)
        return refreshed
      }),
    },
  })
  // A chat conversation this module starts and drives: create, follow its
  // events, send a steer, read the transcript back. Only this module's own
  // conversations are reachable; the host says whether chats exist at all.
  studio.registerMethods({
    askForecaster: {
      access: 'operate',
      params: anything,
      handler: answering(async (workspaceId: unknown) => {
        if (typeof workspaceId !== 'string' || workspaceId.trim().length === 0) {
          throw new Error('weather-deck:ask-forecaster requires a workspace id.')
        }
        if (!studio.supports('conversations')) return { ok: false as const, reason: 'chats are unavailable' }
        const conversations = getConversationService(studio)
        const created = await conversations.create({
          workspaceId,
          prompt: "Summarize today's forecast for the workspace city.",
          skills: ['weather-deck-forecast'],
          name: 'Forecaster',
        })
        if (!created.ok) return { ok: false as const, reason: `${created.code}: ${created.message}` }
        const ref = { workspaceId, agentId: created.conversation.agentId }
        const seen: ModuleConversationEvent[] = []
        const off = conversations.subscribe(ref, (event) => {
          seen.push(event)
          if (event.type === 'approval_requested' && typeof event.payload?.requestId === 'string') {
            void conversations.respondToApproval(ref, { requestId: event.payload.requestId, approved: false })
          }
        })
        const steered = await conversations.send(ref, { message: 'Keep it to one line.', steer: true })
        if (!steered.ok && steered.code === 'not_owned') throw new Error(steered.message)
        const transcript = await conversations.transcript(ref)
        off()
        return {
          ok: true as const,
          sessionId: created.conversation.sessionId,
          events: transcript.ok ? transcript.events.length : seen.length,
          open: conversations.list({ workspaceId }).length,
        }
      }),
    },
  })
  // Brokered credentials: the forecast API key goes to the one origin it was
  // stored for, and the GitHub call rides the user's sign-in. Neither the key
  // nor the token is ever in this module's hands.
  studio.registerMethods({
    saveApiKey: {
      access: 'operate',
      params: anything,
      handler: answering(async (key: unknown) => {
        if (typeof key !== 'string' || key.length === 0) throw new Error('weather-deck:save-api-key requires a key.')
        return getSecretsService(studio).set('forecast-api', key, { allowedOrigins: ['https://api.example.com'] })
      }),
    },
  })
  studio.registerMethods({
    fetchForecast: {
      access: 'read',
      params: anything,
      handler: answering(async (city: unknown) => {
        const secrets = getSecretsService(studio)
        if (!(await secrets.has('forecast-api'))) return { ok: false as const, code: 'not_set' as const }
        const response = await secrets.fetchWithSecret(
          'forecast-api',
          `https://api.example.com/forecast?city=${encodeURIComponent(String(city))}`,
          { placement: { header: 'Authorization', scheme: 'Bearer' }, timeoutMs: 10_000 },
        )
        return response.ok ? { ok: true as const, body: response.body } : { ok: false as const, code: response.code }
      }),
    },
  })
  studio.registerMethods({
    forecastIssues: {
      access: 'read',
      params: anything,
      handler: answering(async () => {
        const github = getGitHubService(studio)
        const status = await github.status()
        if (!status.signedIn) return 0
        const issues = await github.request({ route: '/repos/acme/weather/issues', params: { state: 'open' } })
        return issues.ok && Array.isArray(issues.data) ? issues.data.length : 0
      }),
    },
  })
  studio.registerSidecar({ id: 'weather-deck-poller', kind: 'process', description: 'Background forecast poller.' })
  studio.onStartup(() => {
    studio.notify({ severity: 'info', title: 'Weather Deck ready' })
  })
}

// The same function as the default export, typed as the entry contract.
const activateWorker: ExtensionActivate = activate
export default activateWorker
