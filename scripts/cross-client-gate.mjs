#!/usr/bin/env node
// The cross-client gate: one real Studio server build driven by several of its
// clients at once (tests/cross-client/main.ts says what and how).
//
//   npm run build:server && npm run test:cross-client [-- --require-ssh]
//
// It bundles the gate, the server host and the phone's protocol client with
// esbuild into node_modules/.cache/sprintengine/cross-client/, then runs the
// gate under plain Node. Everything it writes at run time goes under a fresh
// temporary directory, never into the checkout.
//
// The SSH machine leg runs with STUDIO_TEST_DOCKER=1 and a Docker that answers
// (the test sshd image is built here if this Docker has none). `--require-ssh`
// makes a leg that could not run a failure, as CI does.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const serverBundle = join(root, 'out', 'server', 'server.cjs')
if (!existsSync(serverBundle)) {
  console.error(`cross-client gate: ${serverBundle} is missing. Run npm run build:server first.`)
  process.exit(1)
}
const out = join(root, 'node_modules', '.cache', 'sprintengine', 'cross-client')
mkdirSync(out, { recursive: true })

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  packages: 'external',
  logLevel: 'warning',
  sourcemap: 'inline',
}
await build({
  ...common,
  entryPoints: [join(root, 'tests', 'cross-client', 'main.ts')],
  outfile: join(out, 'gate.cjs'),
  tsconfig: join(root, 'tsconfig.tests.json'),
})
await build({
  ...common,
  entryPoints: [join(root, 'tests', 'cross-client', 'host.ts')],
  outfile: join(out, 'host.cjs'),
  tsconfig: join(root, 'tsconfig.tests.json'),
})
// The phone's own modules, with the one native module they reach replaced.
await build({
  ...common,
  packages: undefined,
  entryPoints: [join(root, 'mobile', 'src', '__gate__', 'phoneProtocol.ts')],
  outfile: join(out, 'phone.cjs'),
  // The phone's tsconfig extends Expo's, which is not installed beside this one; nothing in it shapes the output.
  tsconfigRaw: {},
  alias: { 'expo-file-system/legacy': join(root, 'tests', 'cross-client', 'expo-file-system-node.ts') },
})

const requireSsh = process.argv.includes('--require-ssh')
if (process.env.STUDIO_TEST_DOCKER === '1' && spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0) {
  const image = 'sprintengine-test-sshd:1'
  if (spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status !== 0) {
    const fixtures = join(root, 'src', 'main', 'environments', 'ssh', '__fixtures__')
    console.log(`cross-client gate: building ${image} (once per Docker)…`)
    execFileSync('docker', ['build', '-q', '-t', image, '-f', join(fixtures, 'sshd.Dockerfile'), fixtures], {
      stdio: 'inherit',
    })
  }
}

const run = spawnSync(
  process.execPath,
  [
    '--enable-source-maps',
    join(out, 'gate.cjs'),
    JSON.stringify({
      root,
      serverBundle,
      hostBundle: join(out, 'host.cjs'),
      phoneBundle: join(out, 'phone.cjs'),
      requireSsh,
    }),
  ],
  { stdio: 'inherit', cwd: root },
)
process.exit(run.status ?? 1)
