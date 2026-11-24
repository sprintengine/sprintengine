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
  // What it starts keeps a starter: the one they share, else no one.
  const agent = { kind: 'agent', ceiling: 'auto' } as const
  const twoCalls = heldToAll(ownerInvoker(null, 'the agent', agent), [ownerInvoker('auto', 'the agent', agent)])
  assert.deepEqual(twoCalls.starter, agent)
  assert.deepEqual(held.starter, { kind: 'nobody' }, 'the person and a device share no starter')
})

const POLLER = `
const ticks = []
let late = null
const read = (handler) => ({ access: 'read', params: (value) => ({ ok: true, params: value }), handler })
exports.activate = (studio) => {
  // A poller, as a background extension runs one: its own work, long after startup.
  setInterval(() => {
    studio.getWorkspaceGitInfo('ws-1').then(
      (answer) => ticks.push(answer.ok ? 'ok' : answer.code),
      (error) => ticks.push(error.code),
    )
  }, 40)
  studio.registerMethods({
    ticks: read(async () => ({ ok: true, result: ticks })),
    // A timer set while serving whoever calls this: theirs, and it ends with their call.
    later: read(async () => {
      setTimeout(() => {
        studio.getWorkspaceGitInfo('ws-1').then(
          (answer) => (late = answer.ok ? 'ok' : answer.code),
          (error) => (late = error.code),
        )
      }, 40)
      return { ok: true, result: null }
    }),
    late: read(async () => ({ ok: true, result: late })),
  })
}
`

test('a background extension’s own timers keep working after startup; one set during a device’s call does not', async () => {
  harness = startWorkerHarness([{ id: 'poller', main: POLLER, permissions: ['workspace:read'], background: true }])
  const reader: ExtensionInvoker = {
    principal: studioPrincipal({ owner: false, permissions: ['extension:read', 'workspace:read'] }),
    permissionCeiling: 'auto',
    label: 'this device',
  }
  const ask = (method: string, invoker: ExtensionInvoker = ownerInvoker()) =>
    harness!.load.kernel.callModuleMethod({
      moduleId: 'local.poller',
      method,
      access: 'read',
      params: {},
      clientId: invoker.label,
      invoker,
    })
  let ticks: string[] = []
  for (let tries = 0; ticks.length < 5 && tries < 200; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    const answer = await ask('ticks')
    if (answer.ok && answer.answer.ok) ticks = answer.answer.result as string[]
  }
  assert.ok(ticks.length >= 5, 'it ticked several times after it started')
  assert.deepEqual([...new Set(ticks)], ['ok'], 'every tick was admitted, as the person who approved it')

  // The device could read a workspace's git itself; its call has ended by the time the timer fires.
  assert.equal((await ask('later', reader)).ok, true)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.deepEqual(await ask('late'), { ok: true, answer: { ok: true, result: 'invocation_ended' } })
})

// A companion's structured run, as the companion service runs one: it hears
// the run's phases, and awaits the validator on each answer, retrying once.
const COMPANIONS = {
  attach: (_moduleId: string, spec: { workspaceId: string; agentId: string }) => ({
    workspaceId: spec.workspaceId,
    agentId: spec.agentId,
    status: () => 'absent',
    onStatus: () => () => undefined,
    onEvent: () => () => undefined,
    interrupt: () => undefined,
    dispose: () => undefined,
    send: async () => undefined,
    respondToApproval: async () => ({ ok: true }),
    runStructured: async (options: {
      onPhase?: (phase: string) => void
      validate: (
        raw: unknown,
      ) =>
        | { ok: boolean; value?: unknown; errors?: string[] }
        | Promise<{ ok: boolean; value?: unknown; errors?: string[] }>
    }) => {
      for (const [attempt, raw] of [{ wrong: true }, { score: 3 }].entries()) {
        options.onPhase?.(attempt === 0 ? 'running' : 'retrying')
        const result = await options.validate(raw)
        if (result.ok) return result.value
      }
      throw new Error('No valid answer.')
    },
  }),
}

const STRUCTURED = `
const read = (handler) => ({ access: 'read', params: (value) => ({ ok: true, params: value }), handler })
exports.activate = (studio) => {
  studio.registerMethods({
    rate: read(async () => {
      const companions = studio.requireService({ key: 'companion-agents.module-service' })
      const guide = await companions.attach(studio.moduleId, {
        workspaceId: 'ws-1', agentId: 'guide', name: 'Guide', workspaceRoot: '/Users/dev/project', systemPrompt: 'Help.',
      })
      const phases = []
      const score = await guide.runStructured({
        prompt: 'Rate it',
        onPhase: (phase) => phases.push(phase),
        validate: async (raw) =>
          typeof raw.score === 'number' ? { ok: true, value: raw.score * 10 } : { ok: false, errors: ['score must be a number'] },
      })
      return { ok: true, result: { score, phases } }
    }),
  })
}
`

test('a companion’s structured run crosses: its validator and its phases are called back, and the verdict returns', async () => {
  harness = startWorkerHarness(
    [{ id: 'rater', main: STRUCTURED, permissions: ['agents:companion'] }],
    {},
    { 'companion-agents.module-service': COMPANIONS },
  )
  const answer = await harness.load.kernel.callModuleMethod({
    moduleId: 'local.rater',
    method: 'rate',
    access: 'read',
    params: {},
    clientId: 'test',
    invoker: ownerInvoker(),
  })
  assert.deepEqual(answer, { ok: true, answer: { ok: true, result: { score: 30, phases: ['running', 'retrying'] } } })
})

// A watch answers its current value as it is registered: a worker that
// registers one while it activates hears that first delivery.
const WATCHER = `
let seen = null
const read = (handler) => ({ access: 'read', params: (value) => ({ ok: true, params: value }), handler })
exports.activate = (studio) => {
  studio.requireService({ key: 'conversation.module-service' }).watch(studio.moduleId, undefined, (list) => {
    seen = list
  })
  studio.registerMethods({ seen: read(async () => ({ ok: true, result: seen })) })
}
`

test('a listener registered while the worker activates hears its first delivery', async () => {
  const conversations = {
    watch: (_moduleId: string, _filter: unknown, listener: (list: unknown[]) => void) => {
      listener([{ agentId: 'agent-1' }])
      return () => undefined
    },
  }
  harness = startWorkerHarness(
    [{ id: 'watcher', main: WATCHER, permissions: ['conversation:own'] }],
    {},
    { 'conversation.module-service': conversations },
  )
  let seen: unknown = null
  for (let tries = 0; seen === null && tries < 50; tries++) {
    const answer = await harness.load.kernel.callModuleMethod({
      moduleId: 'local.watcher',
      method: 'seen',
      access: 'read',
      params: {},
      clientId: 'test',
      invoker: ownerInvoker(),
    })
    if (answer.ok && answer.answer.ok) seen = answer.answer.result
    if (seen === null) await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.deepEqual(seen, [{ agentId: 'agent-1' }])
})

// A companion service that keeps a function it was handed inside an options
// object, and calls it later, during someone else's call.
function keepingCompanions() {
  let kept: ((phase: string) => unknown) | undefined
  return {
    attach: (_moduleId: string, spec: { workspaceId: string; agentId: string }) => ({
      workspaceId: spec.workspaceId,
      agentId: spec.agentId,
      status: () => 'absent',
      onStatus: () => () => undefined,
      onEvent: () => () => undefined,
      interrupt: () => undefined,
      dispose: () => undefined,
      respondToApproval: async () => ({ ok: true }),
      runStructured: async (options: { onPhase?: (phase: string) => unknown }) => {
        kept = options.onPhase
        return 1
      },
      send: async () => {
        await kept?.('late')
      },
    }),
  }
}

const KEEPER = `
let guide = null
let heard = null
const read = (handler) => ({ access: 'read', params: (value) => ({ ok: true, params: value }), handler })
exports.activate = (studio) => {
  studio.registerMethods({
    // The device's call: hands Studio a function inside an options object.
    register: read(async () => {
      const companions = studio.requireService({ key: 'companion-agents.module-service' })
      guide = await companions.attach(studio.moduleId, {
        workspaceId: 'ws-1', agentId: 'guide', name: 'Guide', workspaceRoot: '/Users/dev/project', systemPrompt: 'Help.',
      })
      await guide.runStructured({
        prompt: 'Rate it',
        validate: async () => ({ ok: true, value: 1 }),
        onPhase: async () => {
          const answer = await studio.getWorkspaceGitInfo('ws-1')
          heard = answer.ok ? 'ok' : answer.code
        },
      })
      return { ok: true, result: null }
    }),
    // The person's call: Studio calls the kept function back during it.
    fire: read(async () => {
      await guide.send('go')
      return { ok: true, result: heard }
    }),
  })
}
`

test('a function handed over inside an argument is called back as whoever handed it over, not whoever Studio serves then', async () => {
  harness = startWorkerHarness(
    [{ id: 'keeper', main: KEEPER, permissions: ['agents:companion', 'workspace:read'] }],
    {},
    { 'companion-agents.module-service': keepingCompanions() },
  )
  const companionDevice: ExtensionInvoker = {
    principal: studioPrincipal({ owner: false, permissions: ['extension:read', 'conversation:create'] }),
    permissionCeiling: 'auto',
    label: 'this device',
  }
  const ask = (method: string, invoker: ExtensionInvoker) =>
    harness!.load.kernel.callModuleMethod({
      moduleId: 'local.keeper',
      method,
      access: 'read',
      params: {},
      clientId: invoker.label,
      invoker,
    })
  assert.deepEqual(await ask('register', companionDevice), { ok: true, answer: { ok: true, result: null } })
  // The device holds no `workspace:read`: the call back is the device's, even during the person's call.
  assert.deepEqual(await ask('fire', ownerInvoker()), { ok: true, answer: { ok: true, result: 'not_permitted' } })
})

test('an object an argument holds twice crosses with its functions in both places', async () => {
  const companions = {
    attach: (_moduleId: string, spec: { workspaceId: string; agentId: string }) => ({
      ...COMPANIONS.attach(_moduleId, spec),
      runStructured: async (options: { first: { ping: () => unknown }; second: { ping: () => unknown } }) => {
        await options.first.ping()
        await options.second.ping()
        return 'both'
      },
    }),
  }
  const main = `
const read = (handler) => ({ access: 'read', params: (value) => ({ ok: true, params: value }), handler })
exports.activate = (studio) => studio.registerMethods({
  twice: read(async () => {
    const companions = studio.requireService({ key: 'companion-agents.module-service' })
    const guide = await companions.attach(studio.moduleId, {
      workspaceId: 'ws-1', agentId: 'guide', name: 'Guide', workspaceRoot: '/Users/dev/project', systemPrompt: 'Help.',
    })
    let pings = 0
    const shared = { ping: () => { pings += 1 } }
    const answer = await guide.runStructured({ prompt: 'x', validate: async () => ({ ok: true, value: 1 }), first: shared, second: shared })
    return { ok: true, result: { answer, pings } }
  }),
})
`
  harness = startWorkerHarness(
    [{ id: 'sharer', main, permissions: ['agents:companion'] }],
    {},
    { 'companion-agents.module-service': companions },
  )
  const answer = await harness.load.kernel.callModuleMethod({
    moduleId: 'local.sharer',
    method: 'twice',
    access: 'read',
    params: {},
    clientId: 'test',
    invoker: ownerInvoker(),
  })
  assert.deepEqual(answer, { ok: true, answer: { ok: true, result: { answer: 'both', pings: 2 } } })
})
