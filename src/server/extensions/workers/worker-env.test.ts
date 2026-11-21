import assert from 'node:assert/strict'

import { afterEach, test, vi } from 'vitest'

import { ownerInvoker } from '../../../main/module-host/extension-invocation'
import { buildWorkerEnv } from './worker-env'
import { startWorkerHarness, type WorkerHarness } from '../../../../tests/extension-workers'

// What a worker process starts with: the allow-list, nothing of Studio's, the
// agents' or the shell's credentials, and none of Studio's own Node flags.

test('the environment is the allow-list, and Electron runs as Node', () => {
  const env = buildWorkerEnv(
    {
      PATH: '/usr/bin',
      HOME: '/Users/dev',
      LANG: 'en_GB.UTF-8',
      SPRINTENGINE_AUTOMATION_TOKEN: 'secret',
      SPRINTENGINE_DATA_DIR: '/Users/dev/studio',
      GITHUB_TOKEN: 'ghp_secret',
      ANTHROPIC_API_KEY: 'sk-secret',
      CLAUDE_CODE_ENTRYPOINT: 'studio',
      NODE_OPTIONS: '--require /tmp/hook.js',
      path: '/attacker',
    },
    'darwin',
  )
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/Users/dev', LANG: 'en_GB.UTF-8', ELECTRON_RUN_AS_NODE: '1' })
})

test('on Windows names fold, and the system root keeps its spelling', () => {
  const env = buildWorkerEnv({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', userprofile: 'C:\\Users\\dev' }, 'win32')
  assert.deepEqual(env, {
    PATH: 'C:\\Windows',
    USERPROFILE: 'C:\\Users\\dev',
    SystemRoot: 'C:\\Windows',
    ELECTRON_RUN_AS_NODE: '1',
  })
})

let harness: WorkerHarness | null = null
afterEach(async () => {
  vi.unstubAllEnvs()
  await harness?.close()
  harness = null
})

test('a real worker sees only the allow-list, and runs with no Node flags of Studio’s', async () => {
  vi.stubEnv('SPRINTENGINE_AUTOMATION_TOKEN', 'secret')
  vi.stubEnv('GITHUB_TOKEN', 'ghp_secret')
  vi.stubEnv('NODE_OPTIONS', '')
  harness = startWorkerHarness([
    {
      id: 'nosy',
      main: `exports.activate = (studio) => studio.registerMethods({
        env: { access: 'read', params: (v) => ({ ok: true, params: v }), handler: () => ({ ok: true, result: { keys: Object.keys(process.env).sort(), execArgv: process.execArgv } }) },
      })\n`,
    },
  ])
  const answer = await harness.load.kernel.callModuleMethod({
    moduleId: 'local.nosy',
    method: 'env',
    access: 'read',
    params: {},
    clientId: 'test',
    invoker: ownerInvoker(),
  })
  assert.ok(answer.ok && answer.answer.ok)
  const { keys, execArgv } = answer.answer.result as { keys: string[]; execArgv: string[] }
  assert.deepEqual(execArgv, [])
  assert.ok(keys.includes('PATH'))
  for (const key of keys) {
    assert.ok(
      [
        'PATH',
        'HOME',
        'USERPROFILE',
        'LANG',
        'LC_ALL',
        'LC_CTYPE',
        'TZ',
        'TMPDIR',
        'TEMP',
        'TMP',
        'ELECTRON_RUN_AS_NODE',
      ].includes(key) ||
        // What Node itself sets in a child it starts.
        key === '__CF_USER_TEXT_ENCODING',
      `the worker saw ${key}`,
    )
  }
})
