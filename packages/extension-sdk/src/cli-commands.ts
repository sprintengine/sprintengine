// The authoring commands' arguments, parsed and handed to cli-authoring.ts
// and cli-dev.ts; every failure leaves through `Output.fail` with its code.

import { parseArgs } from 'node:util'

import {
  checkSurfaces,
  checkWorker,
  inspectExtension,
  runExtensionTests,
  validateExtensionFolder,
} from './cli-authoring.js'
import {
  devEmit,
  devHook,
  devList,
  devLoad,
  devLogs,
  devReload,
  devRequest,
  devUnload,
  devWatch,
  extensionDirOf,
  listExtensions,
  shot,
} from './cli-dev.js'
import { CliError, createOutput, type Output } from './cli-output.js'

const COMMON = {
  json: { type: 'boolean' },
  'data-dir': { type: 'string' },
} as const

function parseData(value: string | undefined, required: boolean): unknown {
  if (value === undefined) {
    if (required) throw new CliError('invalid_argument', '--data <json> is required.')
    return undefined
  }
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new CliError('invalid_argument', '--data is JSON.')
  }
}

function positiveInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) throw new CliError('invalid_argument', `--${name} is a whole number.`)
  return number
}

async function run(output: Output, command: string, args: string[]): Promise<void> {
  if (command === 'validate' || command === 'inspect' || command === 'check' || command === 'test') {
    const { positionals } = parseArgs({ args, options: COMMON, allowPositionals: true })
    const target = positionals[0] ?? '.'
    if (command === 'test') {
      const result = await runExtensionTests(target, output.json)
      if (result.code !== 0)
        throw new CliError(
          'extension_tests_failed',
          `The tests failed (exit ${result.code}).`,
          result,
          undefined,
          result.code,
        )
      output.done(result, `${result.files.length} test file(s) passed.`)
    }
    const validated = validateExtensionFolder(extensionDirOf(target))
    if (command === 'validate')
      output.done(
        {
          key: validated.key,
          id: validated.manifest.id,
          tier: validated.manifest.tier,
          files: Object.keys(validated.files).length,
          warnings: validated.warnings,
        },
        [
          `${validated.key} is valid (${validated.manifest.tier} tier, ${Object.keys(validated.files).length} files).`,
          ...validated.warnings.map((w) => `warning: ${w}`),
        ],
      )
    if (command === 'inspect') {
      const inspected = inspectExtension(validated)
      output.done(inspected, JSON.stringify(inspected, null, 2))
    }
    const worker = await checkWorker(validated)
    const surfaces = checkSurfaces(validated.root, validated.manifest)
    const ok = (worker?.ok ?? true) && surfaces.every((surface) => surface.ok)
    const result = { key: validated.key, ok, worker, surfaces }
    if (!ok)
      throw new CliError(
        'extension_check_failed',
        [
          ...(worker && !worker.ok ? [`worker (${validated.manifest.main}): ${worker.error}`] : []),
          ...surfaces
            .filter((surface) => !surface.ok)
            .map((surface) => `${surface.point} ${surface.id}: ${surface.problem}`),
        ].join('\n'),
        result,
      )
    output.done(result, [
      worker
        ? `worker: activated; methods ${worker.ok ? worker.methods.length : 0}, tools ${worker.ok ? worker.tools.length : 0}, hooks ${worker.ok ? worker.hooks.length : 0}`
        : 'worker: none',
      ...surfaces.map((surface) => `${surface.point} ${surface.id}: loads (${surface.modules} module(s))`),
    ])
  }

  if (command === 'shot') {
    const { values, positionals } = parseArgs({
      args,
      options: {
        ...COMMON,
        panel: { type: 'string' },
        door: { type: 'string' },
        settings: { type: 'string' },
        theme: { type: 'string' },
        width: { type: 'string' },
        height: { type: 'string' },
        out: { type: 'string' },
      },
      allowPositionals: true,
    })
    const target = positionals[0] ?? '.'
    if (values.theme !== undefined && values.theme !== 'light' && values.theme !== 'dark')
      throw new CliError('invalid_argument', '--theme is light or dark.')
    const point = values.panel ? 'panels' : values.door ? 'doors' : values.settings ? 'settingsSections' : undefined
    const id = values.panel ?? values.door ?? values.settings
    const width = positiveInt(values.width, 'width')
    const height = positiveInt(values.height, 'height')
    await shot(output, /^[a-z0-9-]+\.[a-z0-9-]+$/u.test(target) ? target : extensionDirOf(target), {
      ...(point && id ? { point, id } : {}),
      ...(values.theme ? { theme: values.theme as 'light' | 'dark' } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(values.out ? { out: values.out } : {}),
      ...(values['data-dir'] ? { dataDir: values['data-dir'] } : {}),
    })
    return
  }

  // Every extension Studio has, and one's log: installed ones too.
  if (command === 'list' || command === 'logs') {
    const { values, positionals } = parseArgs({
      args,
      options: { ...COMMON, after: { type: 'string' } },
      allowPositionals: true,
    })
    const dataDir = values['data-dir'] ? { dataDir: values['data-dir'] } : {}
    if (command === 'list') return listExtensions(output, dataDir)
    const target = positionals[0]
    if (!target) throw new CliError('invalid_argument', 'logs <key|dir> [--after <seq>]')
    return devLogs(output, /^[a-z0-9-]+\.[a-z0-9-]+$/u.test(target) ? target : extensionDirOf(target), {
      ...dataDir,
      ...(values.after ? { after: Number(values.after) } : {}),
    })
  }

  // dev <subcommand>
  const [sub, ...more] = args
  const { values, positionals } = parseArgs({
    args: more,
    options: {
      ...COMMON,
      check: { type: 'boolean' },
      shot: { type: 'string' },
      'shot-panel': { type: 'string' },
      data: { type: 'string' },
      read: { type: 'boolean' },
      after: { type: 'string' },
      'timeout-ms': { type: 'string' },
    },
    allowPositionals: true,
  })
  const dataDir = values['data-dir'] ? { dataDir: values['data-dir'] } : {}
  const target = positionals[0]
  const keyOrDir = (value: string) => (/^[a-z0-9-]+\.[a-z0-9-]+$/u.test(value) ? value : extensionDirOf(value))
  switch (sub) {
    case 'load':
      return devLoad(output, extensionDirOf(target ?? '.'), dataDir)
    case 'reload':
      return devReload(output, target === undefined ? undefined : keyOrDir(target), dataDir)
    case 'watch':
      return devWatch(output, extensionDirOf(target ?? '.'), {
        ...dataDir,
        ...(values.check ? { check: true } : {}),
        ...(values.shot ? { shotDir: values.shot } : {}),
        ...(values['shot-panel'] ? { shotSurface: values['shot-panel'] } : {}),
      })
    case 'unload':
      return devUnload(output, keyOrDir(target ?? '.'), dataDir)
    case 'list':
      return devList(output, dataDir)
    case 'logs':
      return devLogs(output, keyOrDir(target ?? '.'), {
        ...dataDir,
        ...(values.after ? { after: Number(values.after) } : {}),
      })
    case 'request': {
      const method = positionals[1]
      if (!target || !method)
        throw new CliError('invalid_argument', 'dev request <dir|key> <method> [--data <json>] [--timeout-ms <ms>]')
      const timeoutMs = positiveInt(values['timeout-ms'], 'timeout-ms')
      return devRequest(output, keyOrDir(target), method, {
        ...dataDir,
        data: parseData(values.data, false),
        access: values.read ? 'read' : 'operate',
        ...(timeoutMs ? { timeoutMs } : {}),
      })
    }
    case 'hook': {
      const point = positionals[1]
      if (!target || !point) throw new CliError('invalid_argument', 'dev hook <dir|key> <point> --data <json>')
      return devHook(output, keyOrDir(target), point, { ...dataDir, data: parseData(values.data, true) })
    }
    case 'emit': {
      const topic = positionals[1]
      if (!target || !topic) throw new CliError('invalid_argument', 'dev emit <dir|key> <topic> [--data <json>]')
      return devEmit(output, keyOrDir(target), topic, { ...dataDir, data: parseData(values.data, false) })
    }
    default:
      throw new CliError(
        'invalid_argument',
        'dev takes load, reload, watch, unload, list, logs, request, hook or emit. Run sprintengine-extension --help.',
      )
  }
}

/** Run one authoring command; never returns. */
export async function runAuthoringCommand(command: string, args: string[]): Promise<void> {
  const output = createOutput(args.includes('--json'))
  try {
    await run(output, command, args)
  } catch (error) {
    if (error instanceof TypeError && /Unknown option|Unexpected argument/u.test(error.message))
      output.fail(new CliError('invalid_argument', error.message))
    output.fail(error)
  }
}
