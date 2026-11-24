// `sprintengine-extension check`'s child: loads an extension's worker the way
// Studio's worker process does (TypeScript as written, source-hooks.ts),
// activates it against the SDK's fake host with the manifest's permissions,
// and prints one JSON line: what it registered, or where it failed. It runs
// the extension's code on this machine, outside Studio: only on code you trust.
//
//   node check-worker.js <extension-dir> <main> <extension.json path>

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import { installTypeScriptHooks, placeInFolder } from './source-hooks.js'
import { createFakeMainHost, type FakeExtensionManifest } from './testing.js'

const [root = '', main = '', manifestPath = ''] = process.argv.slice(2)

function finish(answer: Record<string, unknown>): never {
  process.stdout.write(`${JSON.stringify(answer)}\n`)
  process.exit(0)
}

async function run(): Promise<void> {
  installTypeScriptHooks(root)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as FakeExtensionManifest
  const fake = createFakeMainHost({ manifest, moduleRoot: root })
  const logs: string[] = []
  for (const level of ['log', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => {
      logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
    }
  }
  try {
    const entry = createRequire(resolve(root, main))(resolve(root, main)) as Record<string, unknown>
    const activate =
      typeof entry.activate === 'function'
        ? entry.activate
        : typeof entry.default === 'function'
          ? entry.default
          : (entry.default as { activate?: unknown } | undefined)?.activate
    if (typeof activate !== 'function')
      throw new Error(`${main} must export activate(studio), as a named export or its default.`)
    await (activate as (host: unknown) => unknown)(fake.host)
    // Registrations a worker makes while it starts settle on the next turns.
    await new Promise((settle) => setTimeout(settle, 50))
    finish({
      ok: true,
      methods: fake.methods.declared(),
      tools: fake.tools.list().map((tool) => tool.name),
      hooks: fake.hooks.registered(),
      logs,
    })
  } catch (error) {
    const place = placeInFolder(error, root)
    finish({
      ok: false,
      error: `${place ? `${place} ` : ''}${error instanceof Error ? error.message : String(error)}`,
      logs,
    })
  }
}

void run()
