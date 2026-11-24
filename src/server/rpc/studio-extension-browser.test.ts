import assert from 'node:assert/strict'

import { afterEach, test } from 'vitest'

import { createMainKernel } from '../../main/module-host/main-host'
import { TerminalsModuleServiceToken } from '../../main/module-host/service-tokens'
import { studioWindowGrant } from './studio-frame-port'
import { createStudioModuleHub } from './studio-modules'
import { createStudioRpcRouter } from './studio-rpc-router'
import { createFakeBackend } from './studio-rpc.test-helper'

// An owner's browser tab holds the owner's grant, and Studio never lets a
// browser reach this machine's terminals directly. Through an extension's
// method it is refused them the same way: the tab's provenance rides with the
// invocation to the host's gate, for every terminal method.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function setup() {
  const kernel = createMainKernel({
    resolveModuleManifest: (id) =>
      id === 'acme.shell'
        ? {
            id,
            displayName: 'Shell',
            version: 1,
            defaultEnabled: true,
            source: 'third-party',
            permissions: ['terminals:send', 'terminals:read'],
          }
        : undefined,
  })
  const reached: string[] = []
  kernel.hostFor('agent-runtime').provideService(TerminalsModuleServiceToken, () => ({
    send: async () => (reached.push('send'), { accepted: true }),
    create: async () => (reached.push('create'), { terminalId: 't' }),
    read: async () => (reached.push('read'), { lines: ['secret'], truncated: false }),
    close: async () => (reached.push('close'), { closed: true as const }),
    list: async () => (reached.push('list'), { terminals: [], truncated: false }),
  }))
  const host = kernel.hostFor('acme.shell')
  host.registerMethods<{
    'terminal.poke': {
      access: 'operate'
      params: { method: 'send' | 'create' | 'read' | 'close' | 'list' }
      result: string
    }
  }>({
    'terminal.poke': {
      access: 'operate',
      params: (value) => ({ ok: true, params: value as { method: 'send' | 'create' | 'read' | 'close' | 'list' } }),
      handler: async ({ method }) => {
        const terminals = host.requireService(TerminalsModuleServiceToken)
        try {
          await terminals[method]('acme.shell', {} as never)
          return { ok: true, result: 'reached' }
        } catch (error) {
          return { ok: true, result: `refused: ${(error as Error).message}` }
        }
      },
    },
  })
  const hub = createStudioModuleHub()
  hub.serveCallsFrom((request) => kernel.callModuleMethod(request))
  const router = createStudioRpcRouter({ backend: createFakeBackend(), info: () => ({}) as never, modules: hub })
  cleanups.push(() => router.close())
  return { router, reached }
}

test('an owner’s browser tab reaches no terminal through an extension’s method; Studio’s own window does', async () => {
  const { router, reached } = setup()
  const grant = studioWindowGrant()
  const window = { connectionId: 'w', slot: 1, ownWindow: true }
  const tab = { connectionId: 't', slot: 2, ownWindow: false, browser: true }
  let n = 0
  const poke = async (method: string, context: object) => {
    const answer = (await router.handle(
      grant,
      'extension.operate',
      { moduleId: 'acme.shell', method: 'terminal.poke', params: { method }, commandId: `c${++n}` } as never,
      context as never,
    )) as { ok: boolean; result?: unknown }
    assert.equal(answer.ok, true)
    return (answer.result as { result: string }).result
  }
  for (const method of ['send', 'create', 'read', 'close', 'list']) {
    assert.match(await poke(method, tab), /^refused: .*which no browser reaches/)
  }
  assert.deepEqual(reached, [], 'nothing reached the terminals for the tab')
  assert.equal(await poke('read', window), 'reached')
  assert.deepEqual(reached, ['read'])
})
