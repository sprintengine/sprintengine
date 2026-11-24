// `dev …` and `shot`: driving the Studio running on this machine through its
// gateway's local socket (cli-studio.ts). A development folder loads from
// where it is and again on every save; `dev watch` follows what happens to it
// (one JSON object per line with --json) until Ctrl-C.

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { CliError, type Output } from './cli-output.js'
import { connectStudio, type StudioTools } from './cli-studio.js'
import { checkSurfaces, checkWorker, validateExtensionFolder } from './cli-authoring.js'
import { EXTENSION_MANIFEST_FILENAME, parseExtensionManifest } from './extension-manifest.js'

type Approval = { state: string; fingerprint?: string; growth?: string[] }
type LoadAnswer = { moduleId: string; path: string; added: boolean; approval: Approval; latestEvent?: number }
type Launch = { status?: string; message?: string; mainLoaded?: boolean }
type ListedFolder = {
  path: string
  moduleId?: string
  approval?: Approval
  waiting?: boolean
  error?: string
  launch?: Launch
}
type DevEvent = {
  seq: number
  key: string
  kind: string
  message: string
  source?: string
  level?: string
  state?: string
  growth?: string[]
  fingerprint?: string
}

/** Said while a folder waits: only the person approves, in Studio's window. */
const WAITING_WORDS = 'waiting for approval in Studio'

/**
 * The refusal while a folder waits for approval: what it would be granted.
 * Nothing here approves it, and no line to copy does: Studio's window asks
 * the person as soon as it is registered (also Settings > Extensions).
 */
function approvalRequired(answer: LoadAnswer, inspectLine: string): CliError {
  return new CliError(
    'approval_required',
    `${answer.moduleId} is loaded from ${answer.path}, ${WAITING_WORDS}: nothing in it runs until the person approves it there.`,
    {
      moduleId: answer.moduleId,
      path: answer.path,
      ...(answer.approval.growth?.length ? { growth: answer.approval.growth } : {}),
    },
    [
      `Studio's window asks the person to approve it now (also Settings > Extensions). What it asks for: ${inspectLine}.`,
      'sprintengine-extension dev watch waits for the approval and goes on by itself.',
    ],
  )
}

/** A path as Studio names it: through every link, so a folder reached by a link is the folder. */
function canonical(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

/** Whether `path` is `folder` or inside it, with either separator. */
function isInFolder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`) || path.startsWith(`${folder}\\`)
}

async function withStudio<T>(dataDir: string | undefined, work: (studio: StudioTools) => Promise<T>): Promise<T> {
  const studio = await connectStudio(dataDir ? { dataDir } : {})
  try {
    return await work(studio)
  } finally {
    studio.close()
  }
}

/** The extension a command names: a folder (its development folder) or an install key. */
async function moduleIdOf(studio: StudioTools, target: string): Promise<string> {
  if (/^[a-z0-9-]+\.[a-z0-9-]+$/u.test(target) && !existsSync(target)) return target
  const folder = canonical(target)
  const listed = (await studio.call('extension.dev.list', {})) as { folders?: ListedFolder[] }
  const found = (listed.folders ?? []).find((entry) => isInFolder(folder, entry.path))
  if (found?.moduleId) return found.moduleId
  if (found) throw new CliError('extension_invalid', found.error ?? `${folder} holds no extension Studio loads.`)
  throw new CliError('not_found', `${folder} is not a development folder loaded in Studio.`, undefined, [
    `sprintengine-extension dev load ${folder}`,
  ])
}

export async function devLoad(output: Output, dir: string, options: { dataDir?: string }) {
  const path = canonical(dir)
  validateExtensionFolder(path)
  const answer = await withStudio(options.dataDir, (studio) => studio.call('extension.dev.load', { path }))
  const loaded = answer as unknown as LoadAnswer
  if (loaded.approval.state === 'pending') throw approvalRequired(loaded, `sprintengine-extension inspect ${dir}`)
  output.done(loaded as unknown as Record<string, unknown>, [
    `${loaded.added ? 'Loaded' : 'Reloaded'} ${loaded.moduleId} from ${loaded.path} (${loaded.approval.state}).`,
    'Studio reads it again on every save. `sprintengine-extension dev watch` follows what happens to it.',
  ])
}

/**
 * Read development folders again now: `target`'s, or every one registered.
 * For a folder whose saves Studio does not hear (a network share).
 */
export async function devReload(output: Output, target: string | undefined, options: { dataDir?: string }) {
  const answers = await withStudio(options.dataDir, async (studio) => {
    const listed = ((await studio.call('extension.dev.list', {})) as { folders?: ListedFolder[] }).folders ?? []
    let paths = listed.map((folder) => folder.path)
    if (target !== undefined) {
      const byKey = /^[a-z0-9-]+\.[a-z0-9-]+$/u.test(target) && !existsSync(target)
      const path = byKey ? null : canonical(target)
      const found = listed.find((folder) => (byKey ? folder.moduleId === target : isInFolder(path!, folder.path)))
      if (!found)
        throw new CliError(
          'not_found',
          `${target} is not a development folder loaded in Studio.`,
          undefined,
          byKey ? undefined : [`sprintengine-extension dev load ${target}`],
        )
      paths = [found.path]
    }
    const loaded: LoadAnswer[] = []
    for (const path of paths) loaded.push((await studio.call('extension.dev.load', { path })) as unknown as LoadAnswer)
    return loaded
  })
  output.done(
    { reloaded: answers },
    answers.length === 0
      ? 'No development folders.'
      : answers.map(
          (answer) =>
            `Reloaded ${answer.moduleId} from ${answer.path}${answer.approval.state === 'pending' ? ` (${WAITING_WORDS})` : ''}.`,
        ),
  )
}

export async function devUnload(output: Output, target: string, options: { dataDir?: string }) {
  const looksLikeKey = /^[a-z0-9-]+\.[a-z0-9-]+$/u.test(target) && !existsSync(target)
  const answer = await withStudio(options.dataDir, (studio) =>
    studio.call('extension.dev.unload', looksLikeKey ? { moduleId: target } : { path: canonical(target) }),
  )
  output.done(answer, `Removed ${String(answer.path)} from Studio's development folders.`)
}

export async function devList(output: Output, options: { dataDir?: string }) {
  const answer = await withStudio(options.dataDir, (studio) => studio.call('extension.dev.list', {}))
  const folders = (answer.folders ?? []) as ListedFolder[]
  output.done(
    answer,
    folders.length === 0
      ? 'No development folders.'
      : folders.map((folder) =>
          folder.moduleId
            ? `${folder.moduleId}  ${folder.waiting || folder.approval?.state === 'pending' ? WAITING_WORDS : (folder.approval?.state ?? '')}  ${folder.path}`
            : `(invalid)  ${folder.path}: ${folder.error ?? ''}`,
        ),
  )
}

/** Every third-party extension Studio has, installed or a development folder, as `extension.list` reports it. */
export async function listExtensions(output: Output, options: { dataDir?: string }) {
  const answer = await withStudio(options.dataDir, (studio) => studio.call('extension.list', { source: 'third-party' }))
  const modules = (answer.modules ?? []) as Array<Record<string, unknown>>
  output.done(
    answer,
    modules.length === 0
      ? 'No extensions installed.'
      : modules.map((module) =>
          [module.id, module.version, module.enabled ? 'on' : 'off', module.reason ?? module.status ?? '']
            .filter((part) => part !== undefined && part !== '')
            .map(String)
            .join('  '),
        ),
  )
}

function eventWords(event: DevEvent): string {
  switch (event.kind) {
    case 'log':
      return `[${event.source ?? 'worker'}] ${event.message}`
    case 'reloaded':
      return `↻ reloaded ${event.key}`
    case 'approval':
      return `! ${event.key} ${event.message} (${WAITING_WORDS})`
    case 'status':
      return `${event.key} is ${event.state ?? ''}${event.message ? `: ${event.message}` : ''}`
    default:
      return `${event.kind} ${event.key}: ${event.message}`
  }
}

export async function devLogs(output: Output, target: string, options: { dataDir?: string; after?: number }) {
  const answer = await withStudio(options.dataDir, async (studio) => {
    const moduleId = await moduleIdOf(studio, target)
    return studio.call('extension.dev.events', { moduleId, after: options.after ?? 0, limit: 500 })
  })
  const events = (answer.events ?? []) as DevEvent[]
  output.done(answer, events.length === 0 ? 'Nothing logged yet.' : events.map(eventWords))
}

export async function devRequest(
  output: Output,
  target: string,
  method: string,
  options: { data?: unknown; access?: 'read' | 'operate'; timeoutMs?: number; dataDir?: string },
) {
  const answer = await withStudio(options.dataDir, async (studio) => {
    const moduleId = await moduleIdOf(studio, target)
    return studio.call(
      'extension.dev.request',
      {
        moduleId,
        method,
        access: options.access ?? 'operate',
        ...(options.data === undefined ? {} : { params: options.data }),
      },
      options.timeoutMs,
    )
  })
  output.done(answer, JSON.stringify(answer.result, null, 2))
}

export async function devHook(
  output: Output,
  target: string,
  point: string,
  options: { data: unknown; dataDir?: string },
) {
  const answer = await withStudio(options.dataDir, async (studio) => {
    const moduleId = await moduleIdOf(studio, target)
    return studio.call('extension.dev.hook', { moduleId, point, event: options.data }, 30_000)
  })
  output.done(answer, JSON.stringify(answer.answer, null, 2))
}

export async function devEmit(
  output: Output,
  target: string,
  topic: string,
  options: { data?: unknown; dataDir?: string },
) {
  const answer = await withStudio(options.dataDir, async (studio) => {
    const moduleId = await moduleIdOf(studio, target)
    return studio.call('extension.dev.emit', {
      moduleId,
      topic,
      ...(options.data === undefined ? {} : { payload: options.data }),
    })
  })
  output.done(answer, `Sent "${topic}" to ${String(answer.moduleId)}'s open frames.`)
}

/** One of Studio's events, made up, to a development folder's worker and surfaces alone. */
export async function devStudioEvent(
  output: Output,
  target: string,
  event: string,
  options: { data?: unknown; dataDir?: string },
) {
  const answer = await withStudio(options.dataDir, async (studio) => {
    const moduleId = await moduleIdOf(studio, target)
    return studio.call('extension.dev.studioEvent', { moduleId, event, payload: options.data })
  })
  output.done(
    answer,
    `Fired ${event} at ${String(answer.moduleId)}: its worker ${String(answer.worker)}; ${String(answer.surfaces)} of its surfaces' subscriptions heard it.`,
  )
}

// ── shot ─────────────────────────────────────────────────────────────────────

export type ShotOptions = {
  point?: 'panels' | 'doors' | 'settingsSections'
  id?: string
  theme?: 'light' | 'dark'
  width?: number
  height?: number
  out?: string
  /** The folder shots go to when `out` is not given. */
  outDir?: string
  dataDir?: string
}

/** The surface a shot draws: the one named, else the first panel, door or settings section. */
function surfaceOf(dir: string | null, options: ShotOptions): { point: string; id: string } {
  if (options.point && options.id) return { point: options.point, id: options.id }
  if (!dir) throw new CliError('invalid_argument', 'Name the surface: --panel <id>, --door <id> or --settings <id>.')
  // Only extension.json: a surface whose code does not load is still pictured, showing its error.
  let parsed
  try {
    parsed = parseExtensionManifest(readFileSync(join(dir, EXTENSION_MANIFEST_FILENAME), 'utf8'))
  } catch {
    throw new CliError('extension_invalid', `No readable ${EXTENSION_MANIFEST_FILENAME} in ${dir}.`)
  }
  if (!parsed.ok)
    throw new CliError('extension_invalid', `${dir}'s extension.json is not valid.`, { issues: parsed.issues })
  const manifest = parsed.manifest
  for (const point of ['panels', 'doors', 'settingsSections'] as const) {
    const list = manifest.contributes[point]
    const chosen = options.point === point && options.id ? list.find((each) => each.id === options.id) : list[0]
    if ((!options.point || options.point === point) && chosen) return { point, id: chosen.id }
  }
  throw new CliError('invalid_argument', 'It has no panel, door or settings section to picture.')
}

export async function takeShot(studio: StudioTools, target: string, options: ShotOptions) {
  const folder = existsSync(target) ? canonical(target) : null
  const moduleId = await moduleIdOf(studio, target)
  const surface = surfaceOf(folder, options)
  const base =
    options.outDir ?? (folder ? join(folder, '.sprintengine', 'shots') : join(process.cwd(), '.sprintengine', 'shots'))
  const out = options.out ? resolve(options.out) : join(base, `${moduleId}-${surface.id}.png`)
  if (!isAbsolute(out) || !out.toLowerCase().endsWith('.png'))
    throw new CliError('invalid_argument', '--out is a .png file.')
  return studio.call(
    'visual.extension_shot',
    {
      moduleId,
      point: surface.point,
      id: surface.id,
      out,
      theme: options.theme ?? 'dark',
      ...(options.width ? { width: options.width } : {}),
      ...(options.height ? { height: options.height } : {}),
    },
    60_000,
  )
}

export async function shot(output: Output, target: string, options: ShotOptions) {
  const answer = await withStudio(options.dataDir, (studio) =>
    takeShot(studio, target, options).catch((error: unknown) => {
      if (error instanceof CliError && error.code === 'unavailable' && /unknown tool|not found/iu.test(error.message))
        throw new CliError('shot_failed', 'This Studio has no desktop window to draw in; a shot needs the desktop app.')
      throw error
    }),
  )
  const errors = (answer.errors ?? []) as string[]
  if (errors.length > 0 && !output.json) for (const error of errors) console.error(`[frame] ${error}`)
  output.done(
    answer,
    `Wrote ${String(answer.path)} (${String(answer.width)}x${String(answer.height)}${answer.settled ? '' : ', not settled'}).`,
  )
}

// ── dev watch ────────────────────────────────────────────────────────────────

/** How a folder's extension stands in Studio now, from `extension.dev.list`: for a watch's check. */
async function liveStatus(
  studio: StudioTools,
  path: string,
): Promise<{ ok: boolean; status: string; message?: string }> {
  const listed = ((await studio.call('extension.dev.list', {})) as { folders?: ListedFolder[] }).folders ?? []
  const folder = listed.find((entry) => entry.path === path)
  if (!folder) return { ok: false, status: 'not_loaded', message: `${path} is not loaded in Studio.` }
  if (!folder.moduleId) return { ok: false, status: 'invalid', ...(folder.error ? { message: folder.error } : {}) }
  if (folder.waiting || folder.approval?.state === 'pending') return { ok: false, status: 'awaiting_approval' }
  const status = folder.launch?.status ?? 'unknown'
  return {
    ok: status === 'runs_worker' || status === 'runs_without_worker',
    status,
    ...(folder.launch?.message ? { message: folder.launch.message } : {}),
  }
}

/** Wait until the person approved `path` in Studio, checking every second. */
async function untilApproved(studio: StudioTools, path: string): Promise<void> {
  for (;;) {
    await new Promise((settle) => setTimeout(settle, 1000))
    const listed = ((await studio.call('extension.dev.list', {})) as { folders?: ListedFolder[] }).folders ?? []
    const folder = listed.find((entry) => entry.path === path)
    if (!folder) throw new CliError('not_found', `${path} was removed from Studio while it waited for approval.`)
    if (folder.moduleId && !folder.waiting && folder.approval?.state !== 'pending') return
  }
}

/**
 * Load a folder, then follow it until Ctrl-C: each save prints `reloaded`
 * (and with --check a `check`, with --shot a fresh `shot`), the lines its
 * worker and frames print as `log` (errors at file:line:col), `status`
 * changes, and `approval` when a save asks for more. A folder that waits for
 * approval prints `waiting` and waits for the person to approve it in
 * Studio's window, then goes on. Ctrl-C removes the folder again when this
 * watch added it, approved or not.
 */
export async function devWatch(
  output: Output,
  dir: string,
  options: { check?: boolean; shotDir?: string; shotSurface?: string; dataDir?: string },
) {
  validateExtensionFolder(canonical(dir))
  const studio = await connectStudio(options.dataDir ? { dataDir: options.dataDir } : {})
  const loaded = (await studio.call('extension.dev.load', { path: canonical(dir) })) as unknown as LoadAnswer
  // Studio's name for it, used for everything after: its real path.
  const path = loaded.path
  const key = loaded.moduleId
  let stopping = false
  const stop = async (code: number) => {
    if (stopping) process.exit(code)
    stopping = true
    if (loaded.added) {
      await studio.call('extension.dev.unload', { path }).catch(() => undefined)
      output.line({ type: 'unloaded', key, path }, `Removed ${path} from Studio.`)
    }
    studio.close()
    process.exit(code)
  }
  process.on('SIGINT', () => void stop(0))
  process.on('SIGTERM', () => void stop(0))
  output.line({ type: 'loaded', key, path, added: loaded.added }, `Loaded ${key} from ${path}; watching. Ctrl-C stops.`)
  if (loaded.approval.state === 'pending') {
    output.line(
      { type: 'waiting', key, path, ...(loaded.approval.growth?.length ? { growth: loaded.approval.growth } : {}) },
      `${key} is ${WAITING_WORDS}: Studio's window asks the person to approve it.`,
    )
    try {
      await untilApproved(studio, path)
    } catch (error) {
      studio.close()
      output.fail(error)
    }
    output.line({ type: 'approved', key, path }, `${key} was approved.`)
  }

  const afterLoad = async () => {
    if (options.check) {
      // Live first: what Studio runs now, then the folder as this machine reads it.
      const live = await liveStatus(studio, path).catch((error: unknown) => ({
        ok: false,
        status: 'unknown',
        message: error instanceof Error ? error.message : String(error),
      }))
      const liveWords = live.ok ? '' : `live: ${live.status}${live.message ? ` (${live.message})` : ''}`
      try {
        const validated = validateExtensionFolder(path)
        const worker = await checkWorker(validated)
        const surfaces = checkSurfaces(path, validated.manifest)
        const offline = (worker?.ok ?? true) && surfaces.every((surface) => surface.ok)
        const ok = offline && live.ok
        output.line(
          { type: 'check', key, ok, offline: { ok: offline, worker, surfaces }, live },
          ok
            ? '✓ check passed'
            : `✗ check: ${[liveWords, worker && !worker.ok ? `worker: ${worker.error}` : '', ...surfaces.filter((s) => !s.ok).map((s) => `${s.id}: ${s.problem}`)].filter(Boolean).join('; ')}`,
        )
      } catch (error) {
        const issues = error instanceof CliError ? error.data?.issues : undefined
        output.line(
          {
            type: 'check',
            key,
            ok: false,
            offline: { ok: false, error: error instanceof Error ? error.message : String(error), issues },
            live,
          },
          `✗ check: ${[liveWords, error instanceof Error ? error.message : String(error)].filter(Boolean).join('; ')}`,
        )
      }
    }
    if (options.shotDir) {
      try {
        const picture = await takeShot(studio, path, {
          outDir: resolve(options.shotDir),
          ...(options.shotSurface ? { id: options.shotSurface, point: 'panels' as const } : {}),
        })
        output.line(
          { type: 'shot', key, ...picture },
          `📷 ${String(picture.path)}${picture.settled ? '' : ' (not settled)'}`,
        )
      } catch (error) {
        output.line(
          { type: 'shot_failed', key, message: error instanceof Error ? error.message : String(error) },
          `shot failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }
  await afterLoad()

  let after = loaded.latestEvent ?? 0
  let failures = 0
  for (;;) {
    await new Promise((settle) => setTimeout(settle, 300))
    let answer: Record<string, unknown>
    try {
      answer = await studio.call('extension.dev.events', { moduleId: key, after, limit: 200 })
      failures = 0
    } catch {
      failures += 1
      if (failures >= 10) {
        output.line({ type: 'disconnected', key }, 'Studio stopped answering.')
        process.exit(1)
      }
      continue
    }
    const events = (answer.events ?? []) as DevEvent[]
    let reloaded = false
    for (const event of events) {
      after = Math.max(after, event.seq)
      output.line({ type: event.kind, ...event }, eventWords(event))
      if (event.kind === 'reloaded') reloaded = true
    }
    if (reloaded) await afterLoad()
  }
}

/** Where a project's extension folder is: `dir` itself, or its `extension/`. */
export function extensionDirOf(dir: string): string {
  const root = resolve(dir)
  if (existsSync(join(root, 'extension.json'))) return root
  if (existsSync(join(root, 'extension', 'extension.json'))) return join(root, 'extension')
  return root
}
