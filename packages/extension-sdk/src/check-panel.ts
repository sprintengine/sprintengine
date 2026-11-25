// `sprintengine-extension check`'s child for components panels: loads each
// panel's module as Studio loads it (TypeScript and JSX as written, the JSX
// compiled for the components module), mounts the worker first when there is
// one, and renders the panel against the SDK's fake Studio once per scenario
// (`<entry>.check.ts`, else once against an empty Studio). Prints one JSON
// line: what each scenario drew and what went wrong. It runs the extension's
// code on this machine, outside Studio: only on code you trust.
//
//   node check-panel.js <extension-dir> <extension.json path> <panels JSON>
//
// `panels` is `[{ id, entry, files }]`, paths relative to the folder.

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { PanelModule } from './components/runtime/renderer.js'
import { installJsxHooks } from './source-jsx-hooks.js'
import { installTypeScriptHooks, placeInFolder } from './source-hooks.js'
import { runPanelScenario, type CheckScenario, type PanelScenarioResult } from './testing-components.js'
import { createFakeMainHost, type FakeExtensionManifest, type FakeMainHost } from './testing.js'

const [root = '', manifestPath = '', panelsJson = '[]'] = process.argv.slice(2)

type PanelInput = { id: string; entry: string; files: string[] }

export type PanelCheckScenario = { name: string } & PanelScenarioResult

export type PanelCheck = {
  id: string
  entry: string
  /** The scenarios file, when the panel has one. */
  scenarios?: string
  /** Why the panel or its scenarios could not load; then `results` is empty. */
  problem?: string
  results: PanelCheckScenario[]
}

export type PanelCheckAnswer = { worker?: string; panels: PanelCheck[]; logs: string[] }

const SCENARIO_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs']

function finish(answer: PanelCheckAnswer): never {
  process.stdout.write(`${JSON.stringify(answer)}\n`)
  process.exit(0)
}

/** `file:line:column message`, at the first frame in the extension's own files. */
function located(error: { message: string; stack?: string }): string {
  if (!error.stack) return error.message
  const place = placeInFolder(Object.assign(new Error(error.message), { stack: error.stack }), root)
  return place && !error.message.startsWith(place) ? `${place} ${error.message}` : error.message
}

function described(error: unknown): string {
  const place = placeInFolder(error, root)
  const message = error instanceof Error ? error.message : String(error)
  return place && !message.startsWith(place) ? `${place} ${message}` : message
}

async function activateWorker(manifest: FakeExtensionManifest & { main?: string }): Promise<FakeMainHost> {
  const fake = createFakeMainHost({ manifest, moduleRoot: root })
  const path = resolve(root, manifest.main!)
  const entry = createRequire(path)(path) as Record<string, unknown>
  const activate =
    typeof entry.activate === 'function'
      ? entry.activate
      : typeof entry.default === 'function'
        ? entry.default
        : (entry.default as { activate?: unknown } | undefined)?.activate
  if (typeof activate !== 'function') throw new Error(`${manifest.main} must export activate(studio).`)
  await (activate as (host: unknown) => unknown)(fake.host)
  await new Promise((settle) => setTimeout(settle, 50))
  return fake
}

async function run(): Promise<void> {
  const logs: string[] = []
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    console[level] = (...args: unknown[]) => {
      if (logs.length < 200)
        logs.push(
          args
            .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
            .join(' ')
            .slice(0, 2000),
        )
    }
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as FakeExtensionManifest & { main?: string }
  const panels = JSON.parse(panelsJson) as PanelInput[]
  installTypeScriptHooks(root)
  installJsxHooks(root, {
    components: new Set(panels.flatMap((panel) => panel.files.map((file) => resolve(root, file)))),
  })

  const answer: PanelCheckAnswer = { panels: [], logs }
  // The worker first, so a panel's `worker.read` reaches its methods as in Studio.
  let main: FakeMainHost | undefined
  if (manifest.main) {
    try {
      main = await activateWorker(manifest)
    } catch (error) {
      answer.worker = `${manifest.main}: ${described(error)}`
    }
  }

  for (const panel of panels) {
    const check: PanelCheck = { id: panel.id, entry: panel.entry, results: [] }
    answer.panels.push(check)
    let module: PanelModule
    try {
      module = (await import(pathToFileURL(resolve(root, panel.entry)).href)) as PanelModule
    } catch (error) {
      check.problem = described(error)
      continue
    }
    let scenarios: Record<string, CheckScenario> = { default: {} }
    const stem = panel.entry.replace(/\.[^./]+$/u, '')
    const file = SCENARIO_EXTENSIONS.map((extension) => `${stem}.check${extension}`).find((each) =>
      existsSync(join(root, each)),
    )
    if (file) {
      check.scenarios = file
      try {
        const loaded = (await import(pathToFileURL(resolve(root, file)).href)) as { default?: unknown }
        if (typeof loaded.default !== 'object' || loaded.default === null || Array.isArray(loaded.default))
          throw new Error(`${file} must export its scenarios as its default export: export default defineCheck({ … }).`)
        scenarios = loaded.default as Record<string, CheckScenario>
      } catch (error) {
        check.problem = described(error)
        continue
      }
    }
    for (const [name, scenario] of Object.entries(scenarios)) {
      try {
        const result = await runPanelScenario(module, scenario ?? {}, {
          manifest,
          ...(main ? { main } : {}),
          panelId: panel.id,
        })
        check.results.push({
          name,
          ...result,
          errors: result.errors.map((error) => ({ message: located(error) })),
        })
      } catch (error) {
        check.results.push({
          name,
          errors: [{ message: described(error) }],
          warnings: [],
          refusals: [],
          summary: [],
          tree: null,
        })
      }
    }
  }
  finish(answer)
}

void run()
