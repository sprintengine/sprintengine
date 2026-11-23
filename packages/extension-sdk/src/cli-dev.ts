// `dev …` and `shot`: driving the Studio running on this machine through its
// gateway's local socket (cli-studio.ts). A development folder loads from
// where it is and again on every save; `dev watch` follows what happens to it
// (one JSON object per line with --json) until Ctrl-C.

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { CliError, type Output } from './cli-output.js'
import { connectStudio, type StudioTools } from './cli-studio.js'
import { checkSurfaces, checkWorker, validateExtensionFolder } from './cli-authoring.js'
import { EXTENSION_MANIFEST_FILENAME, parseExtensionManifest } from './extension-manifest.js'

type Approval = { state: string; fingerprint?: string; growth?: string[] }
type LoadAnswer = { moduleId: string; path: string; added: boolean; approval: Approval; latestEvent?: number }
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

/** The words a refusal for approval carries: what it would be granted, and how to approve it. */
function approvalRequired(answer: LoadAnswer, dir: string, inspectLine: string): CliError {
  const fingerprint = answer.approval.fingerprint ?? ''
  return new CliError(
    'approval_required',
    `${answer.moduleId} is loaded from ${answer.path} and waits for approval before anything in it runs.`,
    {
      moduleId: answer.moduleId,
      path: answer.path,
      fingerprint,
      ...(answer.approval.growth?.length ? { growth: answer.approval.growth } : {}),
    },
    [
      `Show the person what it asks for (${inspectLine}) and ask them to approve it in Studio: Settings > Extensions, where it is listed as a development folder.`,
      `Or, if you are the person: sprintengine-extension dev load ${dir} --approve ${fingerprint}`,
    ],
  )
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
  const folder = resolve(target)
  const listed = (await studio.call('extension.dev.list', {})) as {
    folders?: Array<{ path: string; moduleId?: string; error?: string }>
  }
  const found = (listed.folders ?? []).find((entry) => entry.path === folder || folder.startsWith(`${entry.path}/`))
  if (found?.moduleId) return found.moduleId
  if (found) throw new CliError('extension_invalid', found.error ?? `${folder} holds no extension Studio loads.`)
  throw new CliError('not_found', `${folder} is not a development folder loaded in Studio.`, undefined, [
    `sprintengine-extension dev load ${folder}`,
  ])
}

export async function devLoad(output: Output, dir: string, options: { approve?: string; dataDir?: string }) {
  const path = resolve(dir)
  validateExtensionFolder(path)
  const answer = await withStudio(options.dataDir, (studio) =>
    studio.call('extension.dev.load', { path, ...(options.approve ? { approve: options.approve } : {}) }),
  )
  const loaded = answer as unknown as LoadAnswer
  if (loaded.approval.state === 'pending') throw approvalRequired(loaded, dir, `sprintengine-extension inspect ${dir}`)
  output.done(loaded as unknown as Record<string, unknown>, [
    `${loaded.added ? 'Loaded' : 'Reloaded'} ${loaded.moduleId} from ${loaded.path} (${loaded.approval.state}).`,
    'Studio reads it again on every save. `sprintengine-extension dev watch` follows what happens to it.',
  ])
}

export async function devUnload(output: Output, target: string, options: { dataDir?: string }) {
  const looksLikeKey = /^[a-z0-9-]+\.[a-z0-9-]+$/u.test(target) && !existsSync(target)
  const answer = await withStudio(options.dataDir, (studio) =>
    studio.call('extension.dev.unload', looksLikeKey ? { moduleId: target } : { path: resolve(target) }),
  )
  output.done(answer, `Removed ${String(answer.path)} from Studio's development folders.`)
}

export async function devList(output: Output, options: { dataDir?: string }) {
  const answer = await withStudio(options.dataDir, (studio) => studio.call('extension.dev.list', {}))
  const folders = (answer.folders ?? []) as Array<{
    path: string
    moduleId?: string
    approval?: Approval
    error?: string
  }>
  output.done(
    answer,
    folders.length === 0
      ? 'No development folders.'
      : folders.map((folder) =>
          folder.moduleId
            ? `${folder.moduleId}  ${folder.approval?.state ?? ''}  ${folder.path}`
            : `(invalid)  ${folder.path}: ${folder.error ?? ''}`,
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
      return `! ${event.key} ${event.message} Approve it in Settings > Extensions (fingerprint ${event.fingerprint ?? ''}).`
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
  options: { data?: unknown; access?: 'read' | 'operate'; dataDir?: string },
) {
  const answer = await withStudio(options.dataDir, async (studio) => {
    const moduleId = await moduleIdOf(studio, target)
    return studio.call('extension.dev.request', {
      moduleId,
      method,
      access: options.access ?? 'operate',
      ...(options.data === undefined ? {} : { params: options.data }),
    })
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
  const folder = existsSync(target) ? resolve(target) : null
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

/**
 * Load a folder, then follow it until Ctrl-C: each save prints `reloaded`
 * (and with --check a `check`, with --shot a fresh `shot`), the lines its
 * worker and frames print as `log` (errors at file:line:col), `status`
 * changes, and `approval` when a save asks for more. A first load that needs
 * approval fails with `approval_required` (exit 3). Ctrl-C removes the folder
 * again when this watch added it.
 */
export async function devWatch(
  output: Output,
  dir: string,
  options: { check?: boolean; shotDir?: string; shotSurface?: string; approve?: string; dataDir?: string },
) {
  const path = resolve(dir)
  validateExtensionFolder(path)
  const studio = await connectStudio(options.dataDir ? { dataDir: options.dataDir } : {})
  const loaded = (await studio.call('extension.dev.load', {
    path,
    ...(options.approve ? { approve: options.approve } : {}),
  })) as unknown as LoadAnswer
  const key = loaded.moduleId
  let stopping = false
  const stop = async (code: number) => {
    if (stopping) process.exit(code)
    stopping = true
    if (loaded.added) {
      await studio.call('extension.dev.unload', { path: loaded.path }).catch(() => undefined)
      output.line({ type: 'unloaded', key, path: loaded.path }, `Removed ${loaded.path} from Studio.`)
    }
    studio.close()
    process.exit(code)
  }
  if (loaded.approval.state === 'pending') {
    const refusal = approvalRequired(loaded, dir, `sprintengine-extension inspect ${dir}`)
    // The folder stays registered, waiting, as the person needs it there to approve it.
    loaded.added = false
    studio.close()
    output.fail(refusal)
  }
  process.on('SIGINT', () => void stop(0))
  process.on('SIGTERM', () => void stop(0))
  output.line(
    { type: 'loaded', key, path: loaded.path, added: loaded.added },
    `Loaded ${key} from ${loaded.path}; watching. Ctrl-C stops.`,
  )

  const afterLoad = async () => {
    if (options.check) {
      try {
        const validated = validateExtensionFolder(path)
        const worker = await checkWorker(validated)
        const surfaces = checkSurfaces(path, validated.manifest)
        const ok = (worker?.ok ?? true) && surfaces.every((surface) => surface.ok)
        output.line(
          { type: 'check', key, ok, worker, surfaces },
          ok
            ? '✓ check passed'
            : `✗ check: ${[worker && !worker.ok ? `worker: ${worker.error}` : '', ...surfaces.filter((s) => !s.ok).map((s) => `${s.id}: ${s.problem}`)].filter(Boolean).join('; ')}`,
        )
      } catch (error) {
        const issues = error instanceof CliError ? error.data?.issues : undefined
        output.line(
          { type: 'check', key, ok: false, error: error instanceof Error ? error.message : String(error), issues },
          `✗ check: ${error instanceof Error ? error.message : String(error)}`,
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
