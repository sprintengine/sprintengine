import { readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import {
  ENVIRONMENT_ROUTE_KINDS,
  formatEnvironmentRoute,
  isEnvironmentRoute,
  isEnvironmentId,
  orderEnvironmentRoutes,
  parseEnvironmentRoute,
  type EnvironmentDescriptor,
  type EnvironmentId,
  type EnvironmentRoute,
  type EnvironmentRouteKind,
} from '../../../packages/studio-protocol/src/environment'
import { localEnvironmentSource, type EnvironmentSource } from '../../shared/environment-keys'
import { UNKNOWN_CONNECTION, type EnvironmentConnection, type EnvironmentEntry } from '../../shared/environments'
import { isRecord } from '../../shared/records'
import { writeFileAtomicSync } from '../../server/platform/atomic-file'

// The environments this desktop knows (the desktop as a client): every Studio
// it can reach, each with the routes it reaches it by, best first.
//
// Built from what names a machine today, pushed in by whoever owns it: the WSL
// distributions turned on as machines, the saved SSH machines, the desktops
// paired over the tailnet (`environment-keys.ts` turns each record into a
// source). This machine is always here, first.
//
// What a route answered as is kept in `environments.json`, so it survives a
// restart and a rename:
//
//   - Two routes that answer as one Studio are one environment (a desktop
//     that is both paired and saved as an SSH machine).
//   - A distribution renamed in WSL is a new route; when its server answers
//     with the id it had, it joins the environment it was.
//   - A route that now answers as another Studio (the machine reinstalled, or
//     the alias pointed elsewhere) leaves the environment it was in.
//
// A route never reached yet is listed on its own, with no id. The registry
// reaches nothing itself, and no call is routed through it yet: it is the
// list the cut-overs to direct environments read.

export const ENVIRONMENTS_FILENAME = 'environments.json'
const FILE_VERSION = 1

/** One environment as this desktop knows it: the shape every window reads (`src/shared/environments.ts`). */
export type KnownEnvironment = EnvironmentEntry

/** What a route's owner says about its connection now. */
export type EnvironmentConnectionReport = { route: EnvironmentRoute; connection: EnvironmentConnection }

export type EnvironmentSourceKind = 'wsl' | 'ssh' | 'tailnet'

export type EnvironmentRegistry = {
  /** Every environment known now, this machine first, then by best route and name. */
  list(): KnownEnvironment[]
  get(environmentId: EnvironmentId): KnownEnvironment | null
  /**
   * The environment a route listed now reaches, or null: for a route not
   * heard from yet, and for one no owner lists any more (a forgotten pairing).
   */
  environmentOfRoute(route: EnvironmentRoute): EnvironmentId | null
  /** The machines one owner knows, whole: the sources of that kind before are replaced. */
  observe(kind: EnvironmentSourceKind, sources: readonly EnvironmentSource[]): void
  /** What a route answered: the Studio's id, or its whole descriptor. True when that was news. */
  learn(route: EnvironmentRoute, answered: EnvironmentId | EnvironmentDescriptor): boolean
  /**
   * How the connections over one kind of route stand, whole: the reports of
   * that kind before are replaced. A route with no report reads `unknown`.
   * Fed today by each route's owner (SSH machines, the mesh's reachability,
   * the WSL distributions, this machine); by each environment's connection
   * supervisor once the machines are direct environments.
   */
  report(kind: EnvironmentRouteKind, reports: readonly EnvironmentConnectionReport[]): void
  /** Called after any change to `list()`'s answer. */
  onChanged(listener: () => void): () => void
}

type Stored = {
  /** Route string → the id it last answered as. */
  routes: Map<string, EnvironmentId>
  /** Environment id → the last descriptor heard. */
  descriptors: Map<EnvironmentId, EnvironmentDescriptor>
}

export function createEnvironmentRegistry(options: {
  userDataDir: string
  localEnvironmentId: EnvironmentId
  platform: string
  log?: (message: string) => void
}): EnvironmentRegistry {
  const path = join(options.userDataDir, ENVIRONMENTS_FILENAME)
  const loaded = read(path, options.log)
  const stored = loaded.stored
  // An unreadable file is never written over this run: a write would replace
  // every identity it holds with what this run happens to know.
  let writable = loaded.writable
  const local = localEnvironmentSource(options.localEnvironmentId, options.platform)
  const observed = new Map<EnvironmentSourceKind, EnvironmentSource[]>()
  // Route string → its owner's last report, per kind so one owner's report replaces only its own.
  const reported = new Map<EnvironmentRouteKind, Map<string, EnvironmentConnection>>()
  const listeners = new Set<() => void>()
  const sharingLocalId = new Set<string>()
  let current = build()

  function persist(): void {
    if (!writable) return
    if (loaded.malformed) {
      // Moved aside once, before the first write, so what it held can be recovered.
      try {
        renameSync(path, `${path}.malformed-${Date.now()}-${process.pid}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          writable = false
          options.log?.(
            `${ENVIRONMENTS_FILENAME} could not be moved aside (${message(error)}); it is not written over.`,
          )
          return
        }
      }
      loaded.malformed = false
    }
    const body = {
      version: FILE_VERSION,
      routes: Object.fromEntries(stored.routes),
      environments: Object.fromEntries([...stored.descriptors].map(([id, descriptor]) => [id, { descriptor }])),
    }
    try {
      writeFileAtomicSync(path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, exactMode: true })
    } catch (error) {
      options.log?.(`Could not write ${ENVIRONMENTS_FILENAME}: ${message(error)}`)
    }
  }

  /** Record that `route` answered as `id`. True when that is news. */
  function remember(route: EnvironmentRoute, id: EnvironmentId): boolean {
    // Another machine answering as this one is never written down as this one.
    if (id === options.localEnvironmentId && route.kind !== 'local') return false
    const key = formatEnvironmentRoute(route)
    if (stored.routes.get(key) === id) return false
    stored.routes.set(key, id)
    return true
  }

  function sources(): EnvironmentSource[] {
    return [local, ...(observed.get('wsl') ?? []), ...(observed.get('ssh') ?? []), ...(observed.get('tailnet') ?? [])]
  }

  function idOf(source: EnvironmentSource): EnvironmentId | null {
    // The record's own id is the newest word: its owner updates it every time
    // the machine answers. The registry's is for routes with no such record.
    return source.environmentId ?? stored.routes.get(formatEnvironmentRoute(source.route)) ?? null
  }

  function build(): KnownEnvironment[] {
    const byId = new Map<EnvironmentId, EnvironmentSource[]>()
    const unidentified: EnvironmentSource[] = []
    const seen = new Set<string>()
    for (const source of sources()) {
      const key = formatEnvironmentRoute(source.route)
      if (seen.has(key)) continue
      seen.add(key)
      let id = idOf(source)
      if (id === options.localEnvironmentId && source.route.kind !== 'local') {
        // Another machine answering as this one: a data directory copied
        // from here (a restored backup, a migration). It is not this machine,
        // whatever it says, so it is listed on its own.
        if (!sharingLocalId.has(key)) {
          sharingLocalId.add(key)
          options.log?.(`${source.displayName} answers with this machine's environment id; it is listed apart.`)
        }
        id = null
      }
      if (!id) {
        unidentified.push(source)
        continue
      }
      byId.set(id, [...(byId.get(id) ?? []), source])
    }
    const environments: KnownEnvironment[] = []
    for (const [id, group] of byId) environments.push(environment(id, group))
    for (const source of unidentified) environments.push(environment(null, [source]))
    return environments.sort(compareEnvironments)
  }

  function environment(id: EnvironmentId | null, group: EnvironmentSource[]): KnownEnvironment {
    const routes = orderEnvironmentRoutes(group.map((source) => source.route))
    const best = group.find((source) => formatEnvironmentRoute(source.route) === formatEnvironmentRoute(routes[0]!))!
    return {
      environmentId: id,
      displayName: best.displayName,
      routes,
      machine: best.machine,
      descriptor: id ? (stored.descriptors.get(id) ?? null) : null,
      connection: connectionOf(routes),
      compatibility: null,
    }
  }

  // An environment answers if any way in does; otherwise it reads as its
  // best route reports.
  function connectionOf(routes: readonly EnvironmentRoute[]): EnvironmentConnection {
    const reports = routes.map(
      (route) => reported.get(route.kind)?.get(formatEnvironmentRoute(route)) ?? UNKNOWN_CONNECTION,
    )
    return reports.find((report) => report.state === 'up') ?? reports[0] ?? UNKNOWN_CONNECTION
  }

  function changed(): void {
    const next = build()
    if (JSON.stringify(next) === JSON.stringify(current)) return
    current = next
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        options.log?.(`An environment listener threw: ${message(error)}`)
      }
    }
  }

  return {
    list: () => current.map(copy),
    get: (environmentId) => {
      const found = current.find((entry) => entry.environmentId === environmentId)
      return found ? copy(found) : null
    },
    environmentOfRoute: (route) => {
      if (!isEnvironmentRoute(route)) return null
      const key = formatEnvironmentRoute(route)
      for (const entry of current)
        if (entry.routes.some((candidate) => formatEnvironmentRoute(candidate) === key)) return entry.environmentId
      return null
    },
    observe(kind, given) {
      const own: EnvironmentSource[] = []
      for (const source of given) {
        if (source.route.kind !== kind) continue
        // A record from disk naming a machine by an id no route can carry
        // is left out, never thrown on: it is not a route anything takes.
        if (!isEnvironmentRoute(source.route)) {
          options.log?.(`${source.displayName} is not listed: its record does not name a route.`)
          continue
        }
        own.push(isEnvironmentId(source.environmentId) ? source : { ...source, environmentId: null })
      }
      observed.set(kind, own)
      let learned = false
      for (const source of own) if (source.environmentId && remember(source.route, source.environmentId)) learned = true
      if (learned) persist()
      changed()
    },
    learn(route, answered) {
      const descriptor = typeof answered === 'string' ? null : answered
      const id = descriptor ? descriptor.environmentId : (answered as EnvironmentId)
      if (!isEnvironmentId(id) || !isEnvironmentRoute(route)) return false
      let news = remember(route, id)
      if (descriptor && JSON.stringify(stored.descriptors.get(id)) !== JSON.stringify(descriptor)) {
        stored.descriptors.set(id, { ...descriptor, capabilities: [...descriptor.capabilities] })
        news = true
      }
      if (!news) return false
      persist()
      changed()
      return true
    },
    report(kind, reports) {
      const own = new Map<string, EnvironmentConnection>()
      for (const { route, connection } of reports) {
        if (route.kind !== kind || !isEnvironmentRoute(route)) continue
        own.set(formatEnvironmentRoute(route), { ...connection })
      }
      reported.set(kind, own)
      changed()
    },
    onChanged(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function compareEnvironments(a: KnownEnvironment, b: KnownEnvironment): number {
  const rank = (entry: KnownEnvironment) => ENVIRONMENT_ROUTE_KINDS.indexOf(entry.routes[0]!.kind)
  return rank(a) - rank(b) || a.displayName.localeCompare(b.displayName)
}

function copy(entry: KnownEnvironment): KnownEnvironment {
  return {
    ...entry,
    routes: entry.routes.map((route) => ({ ...route })),
    machine: { ...entry.machine },
    connection: { ...entry.connection },
    descriptor: entry.descriptor ? { ...entry.descriptor, capabilities: [...entry.descriptor.capabilities] } : null,
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function read(
  path: string,
  log: ((message: string) => void) | undefined,
): { stored: Stored; writable: boolean; malformed: boolean } {
  const stored: Stored = { routes: new Map(), descriptors: new Map() }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { stored, writable: true, malformed: false }
    log?.(`Could not read ${ENVIRONMENTS_FILENAME} (${message(error)}); it is not written over this run.`)
    return { stored, writable: false, malformed: false }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    log?.(`${ENVIRONMENTS_FILENAME} is not valid JSON; it is kept aside at the next write.`)
    return { stored, writable: true, malformed: true }
  }
  if (!isRecord(parsed)) return { stored, writable: true, malformed: true }
  // An entry that does not read is dropped, not repaired: a guessed id would
  // merge two machines.
  if (isRecord(parsed.routes))
    for (const [key, id] of Object.entries(parsed.routes)) {
      const route = parseEnvironmentRoute(key)
      if (route && isEnvironmentId(id)) stored.routes.set(formatEnvironmentRoute(route), id)
    }
  if (isRecord(parsed.environments))
    for (const [id, entry] of Object.entries(parsed.environments)) {
      const descriptor = isRecord(entry) ? readDescriptor(entry.descriptor) : null
      if (isEnvironmentId(id) && descriptor && descriptor.environmentId === id) stored.descriptors.set(id, descriptor)
    }
  return { stored, writable: true, malformed: false }
}

function readDescriptor(value: unknown): EnvironmentDescriptor | null {
  if (!isRecord(value)) return null
  const { environmentId, kind, displayName, serverVersion, protocolVersion, minProtocolVersion, capabilities } = value
  if (!isEnvironmentId(environmentId)) return null
  if (kind !== 'local' && kind !== 'wsl' && kind !== 'ssh' && kind !== 'tailnet') return null
  if (typeof displayName !== 'string' || typeof serverVersion !== 'string') return null
  if (!Number.isSafeInteger(protocolVersion) || !Number.isSafeInteger(minProtocolVersion)) return null
  if (!Array.isArray(capabilities)) return null
  return {
    environmentId,
    kind,
    displayName,
    serverVersion,
    protocolVersion: protocolVersion as number,
    minProtocolVersion: minProtocolVersion as number,
    capabilities: capabilities.filter((entry): entry is string => typeof entry === 'string'),
  }
}
