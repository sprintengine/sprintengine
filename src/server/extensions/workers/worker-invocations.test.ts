import assert from 'node:assert/strict'

import { afterEach, test } from 'vitest'

import { studioPrincipal } from '../../../../packages/studio-protocol/src/permissions'
import { ownerInvoker, type ExtensionInvoker } from '../../../main/module-host/extension-invocation'
import type { ModuleMethodCallOutcome } from '../../../main/module-host/main-host'
import { heldToAll } from './worker-session'
import { startWorkerHarness, type WorkerHarness } from '../../../../tests/extension-workers'

// Who a worker's calls into Studio run as, across the real process boundary.
//
// The worker below plays the extension that tries: it reads the invocation id
// of every call Studio sends it straight off its IPC channel, and makes calls
// of its own on that channel, bypassing its `studio`, naming whichever id it
// likes, or none. A paired device without `workspace:read` and the person
// call it at the same time; the device's call tries to borrow the person's
// id. Studio's own record of each id decides, and while the worker serves the
// device, nothing it does reaches past what the device may do.

const ADVERSARY = `
const seen = []
process.on('message', (message) => {
  if (message && message.t === 'call' && message.kind === 'method') seen.push({ name: message.name, invocation: message.invocation })
})
let next = 1e9
// A call into Studio made by hand: the id it names is the worker's choice.
const raw = (invocation) => new Promise((resolve) => {
  const id = next++
  const hear = (message) => {
    if (!message || message.t !== 'host-answer' || message.id !== id) return
    process.off('message', hear)
    resolve(message.ok ? { ok: true, value: message.value } : { ok: false, code: message.error.code })
  }
  process.on('message', hear)
  process.send({ t: 'host', id, invocation, target: { host: 'getWorkspaceGitInfo' }, args: [{ value: 'ws-1' }] })
})
const idOf = (name) => seen.filter((entry) => entry.name === name).at(-1).invocation
let release
const holding = new Promise((resolve) => (release = resolve))
const read = (handler) => ({ access: 'read', params: (value) => ({ ok: true, params: value }), handler })
exports.activate = (studio) => {
  studio.registerMethods({
    // The person's call: still running while the device's runs.
    hold: read(async () => {
      const own = await studio.getWorkspaceGitInfo('ws-1')
      await holding
      return { ok: true, result: { own: own.ok } }
    }),
    // The device's call, trying every id it can get.
    probe: read(async () => {
      const own = await studio.getWorkspaceGitInfo('ws-1')
      const borrowed = await raw(idOf('hold'))
      const none = await raw(null)
      const forged = await raw('00000000-0000-4000-8000-000000000000')
      release()
      return { ok: true, result: { own: own.ok ? 'ok' : own.code, borrowed: borrowed.ok ? (borrowed.value.ok ? 'ok' : borrowed.value.code) : borrowed.code, none: none.code, forged: forged.code } }
    }),
    // Later, alone: the person's id from a call that has ended.
    replay: read(async () => {
      const replayed = await raw(idOf('hold'))
      const own = await raw(idOf('replay'))
      return { ok: true, result: { replayed: replayed.code, own: own.ok && own.value.ok ? 'ok' : 'refused' } }
    }),
    // A timer set during a call, firing after it ended.
    later: read(async () => {
      setTimeout(() => {
        studio.getWorkspaceGitInfo('ws-1').then(
          (answer) => { lateAnswer = answer.ok ? 'ok' : answer.code },
          (error) => { lateAnswer = error.code },
        )
      }, 50)
      return { ok: true, result: null }
    }),
    lateAnswer: read(async () => ({ ok: true, result: lateAnswer })),
  })
}
let lateAnswer = null
`

const device: ExtensionInvoker = {
  principal: studioPrincipal({ owner: false, permissions: ['extension:read'] }),
  permissionCeiling: 'auto',
  label: 'this device',
}

let harness: WorkerHarness | null = null
afterEach(async () => {
  await harness?.close()
  harness = null
})

function call(method: string, invoker: ExtensionInvoker): Promise<ModuleMethodCallOutcome> {
  return harness!.load.kernel.callModuleMethod({
    moduleId: 'local.adversary',
    method,
    access: 'read',
    params: {},
    clientId: invoker.label,
    invoker,
  })
}

test('a worker serving two invokers at once cannot borrow, forge, omit or replay an invocation id', async () => {
  harness = startWorkerHarness([{ id: 'adversary', main: ADVERSARY, permissions: ['workspace:read'] }])

  // The person's call starts first and is still running when the device's arrives.
  const held = call('hold', ownerInvoker())
  await new Promise((resolve) => setTimeout(resolve, 200))
  const probed = await call('probe', device)
  assert.deepEqual(probed, {
    ok: true,
    answer: {
      ok: true,
      result: {
        // Its own call is the device's, which holds no `workspace:read`.
        own: 'not_permitted',
        // The person's id, put on the device's work: held to the device too.
        borrowed: 'not_permitted',
        // No id, from an extension that is not a background one.
        none: 'not_admitted',
        // An id Studio never made.
        forged: 'not_admitted',
      },
    },
  })
  assert.deepEqual(
    await held,
    { ok: true, answer: { ok: true, result: { own: true } } },
    'the person alone is not held back',
  )

  // Both calls have ended: the person's id no longer works, and a call's own id does.
  assert.deepEqual(await call('replay', ownerInvoker()), {
    ok: true,
    answer: { ok: true, result: { replayed: 'invocation_ended', own: 'ok' } },
  })
})

test('work left running after a call ends is refused, not run as whoever called', async () => {
  harness = startWorkerHarness([{ id: 'adversary', main: ADVERSARY, permissions: ['workspace:read'] }])
  assert.equal((await call('later', ownerInvoker())).ok, true)
  await new Promise((resolve) => setTimeout(resolve, 300))
  const late = await call('lateAnswer', ownerInvoker())
  assert.deepEqual(late, { ok: true, answer: { ok: true, result: 'invocation_ended' } })
})

test('a call is held to every invoker the worker serves then: their common permissions and the tightest ceiling', () => {
  const owner = ownerInvoker()
  assert.equal(heldToAll(owner, [owner]), owner, 'serving one invoker changes nothing')
  const capped = ownerInvoker('auto', 'the agent')
  const held = heldToAll(owner, [owner, device, capped])
  assert.equal(held.principal.owner, false)
  assert.deepEqual([...held.principal.permissions], ['extension:read'])
  assert.equal(held.permissionCeiling, 'auto')
  assert.match(held.label, /this device and the agent/)
})
