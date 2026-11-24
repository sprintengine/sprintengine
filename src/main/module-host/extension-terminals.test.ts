import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { TerminalSessionSnapshot } from '../../../packages/studio-protocol/src/terminals'
import type { CliPermissionPreset } from '../../shared/cli-permission-preset'
import { createExtensionTerminals, type ExtensionTerminalHost } from './extension-terminals'

// The person's terminals as an extension's worker reaches them, past the
// host's gate: typing through the write hooks, a shell opened in the
// background, output read as plain text, and only its own closed.

type Session = { snapshot: TerminalSessionSnapshot; output: string; typed: string[] }

/** A gate held open until the test lets it go. */
function hold() {
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  return { released, release }
}

function machine(options: { refuse?: string; ceiling?: CliPermissionPreset | null } = {}) {
  const sessions = new Map<string, Session>()
  // Set by a test: the next spawn, or every write, waits for it (a workspace lease, the control plane's queue).
  let spawnHeld: Promise<void> | null = null
  let writeHeld: Promise<void> | null = null
  const spawned: Array<Parameters<ExtensionTerminalHost['spawnShell']>[0]> = []
  const killed: string[] = []
  let ceiling: CliPermissionPreset | null = options.ceiling ?? null
  const add = (sessionId: string, extra: Partial<TerminalSessionSnapshot> = {}, output = '') => {
    sessions.set(sessionId, {
      snapshot: {
        sessionId,
        kind: 'terminal',
        processAlive: true,
        workspaceId: 'ws-1',
        ...extra,
      } as TerminalSessionSnapshot,
      output,
      typed: [],
    })
  }
  const host: ExtensionTerminalHost = {
    list: () => [...sessions.values()].map((session) => session.snapshot),
    async spawnShell(input) {
      spawned.push(input)
      if (spawnHeld) await spawnHeld
      add(input.sessionId)
      return { ok: true, sessionId: input.sessionId }
    },
    async write(sessionId, data, stillMay) {
      if (writeHeld) await writeHeld
      const session = sessions.get(sessionId)
      if (!session) return { ok: false, reason: 'not_found', message: 'gone' }
      // Asked last, as the control plane asks it after its queue and the hooks.
      const withdrawn = stillMay?.()
      if (withdrawn) return { ok: false, reason: 'withdrawn', message: withdrawn }
      // An extension's write hook refused it.
      if (options.refuse && data.includes(options.refuse))
        return { ok: false, reason: 'refused', message: 'The extension "Guard" (local.guard) refused this: no.' }
      session.typed.push(data)
      return { ok: true }
    },
    readTail: (sessionId) => {
      const session = sessions.get(sessionId)
      return session ? { text: session.output, truncated: false } : undefined
    },
    kill(sessionId) {
      killed.push(sessionId)
      sessions.delete(sessionId)
    },
  }
  let available = true
  const terminals = createExtensionTerminals({
    terminals: () => (available ? host : null),
    workspace: (workspaceId) =>
      workspaceId === 'ws-1'
        ? { folderPath: '/Users/dev/notes', remote: false }
        : workspaceId === 'ws-ssh'
          ? { folderPath: '/home/dev/site', remote: true }
          : workspaceId === 'ws-empty'
            ? { folderPath: null, remote: false }
            : null,
    ceiling: () => ceiling,
  })
  return {
    terminals,
    sessions,
    spawned,
    killed,
    add,
    setCeiling: (next: CliPermissionPreset | null) => (ceiling = next),
    setAvailable: (next: boolean) => (available = next),
    holdSpawn: (held: Promise<void> | null) => (spawnHeld = held),
    holdWrites: (held: Promise<void> | null) => (writeHeld = held),
  }
}

const code = (expected: string) => (error: Error & { code?: string }) => error.code === expected

test('send types into any terminal by its id, Enter as a carriage return, through the write hooks', async () => {
  const m = machine({ refuse: 'rm -rf' })
  m.add('terminal-person')
  assert.deepEqual(await m.terminals.send('local.a', { terminalId: 'terminal-person', text: 'ls' }), { accepted: true })
  assert.deepEqual(await m.terminals.send('local.a', { terminalId: 'terminal-person', text: 'pwd', enter: true }), {
    accepted: true,
  })
  assert.deepEqual(m.sessions.get('terminal-person')!.typed, ['ls', 'pwd\r'])
  await assert.rejects(
    m.terminals.send('local.a', { terminalId: 'terminal-person', text: 'rm -rf /', enter: true }),
    code('refused_by_extension'),
  )
  await assert.rejects(m.terminals.send('local.a', { terminalId: 'nope', text: 'ls' }), code('unknown_terminal'))
  await assert.rejects(
    m.terminals.send('local.a', { terminalId: 'terminal-person', text: 42 } as never),
    code('invalid_params'),
  )
  m.sessions.get('terminal-person')!.snapshot.processAlive = false
  assert.deepEqual(await m.terminals.send('local.a', { terminalId: 'terminal-person', text: 'ls' }), {
    accepted: false,
  })
})

test('create opens a shell in the workspace’s folder in the background, and runs its command', async () => {
  const m = machine()
  const { terminalId } = await m.terminals.create('local.a', {
    workspaceId: 'ws-1',
    title: 'Tests',
    command: 'npm test',
  })
  assert.match(terminalId, /^terminal-ext-/)
  assert.equal(m.spawned.length, 1)
  assert.deepEqual(
    { ...m.spawned[0], sessionId: '', terminalId: '' },
    {
      sessionId: '',
      terminalId: '',
      workspaceId: 'ws-1',
      cwd: '/Users/dev/notes',
    },
  )
  assert.deepEqual(m.sessions.get(terminalId)!.typed, ['npm test\r'])
  assert.deepEqual(m.terminals.opened('local.a'), [{ id: terminalId, title: 'Tests' }])
  assert.equal(m.terminals.titleOf(terminalId), 'Tests')
  await assert.rejects(m.terminals.create('local.a', { workspaceId: 'ws-gone' }), code('unknown_workspace'))
  await assert.rejects(m.terminals.create('local.a', { workspaceId: 'ws-ssh' }), code('unavailable'))
  await assert.rejects(m.terminals.create('local.a', { workspaceId: 'ws-empty' }), code('unavailable'))
  m.setAvailable(false)
  await assert.rejects(m.terminals.create('local.a', { workspaceId: 'ws-1' }), code('unavailable'))
})

test('read answers the newest output as plain lines, at most 2000', async () => {
  const m = machine()
  const lines = Array.from({ length: 2500 }, (_, index) => `\u001b[32mline ${index}\u001b[0m`)
  m.add('terminal-person', {}, `${lines.join('\r\n')}\r\n`)
  const all = await m.terminals.read('local.a', { terminalId: 'terminal-person', maxLines: 5000 })
  assert.equal(all.lines.length, 2000)
  assert.equal(all.lines.at(-1), 'line 2499')
  assert.equal(all.truncated, true)
  const few = await m.terminals.read('local.a', { terminalId: 'terminal-person', maxLines: 2 })
  assert.deepEqual(few.lines, ['line 2498', 'line 2499'])
  const default_ = await m.terminals.read('local.a', { terminalId: 'terminal-person' })
  assert.equal(default_.lines.length, 200)
  await assert.rejects(
    m.terminals.read('local.a', { terminalId: 'terminal-person', maxLines: 0 }),
    code('invalid_params'),
  )
  await assert.rejects(m.terminals.read('local.a', { terminalId: 'nope' }), code('unknown_terminal'))
})

test('close closes only a terminal the extension opened', async () => {
  const m = machine()
  m.add('terminal-person')
  const { terminalId } = await m.terminals.create('local.a', { workspaceId: 'ws-1' })
  await assert.rejects(m.terminals.close('local.a', { terminalId: 'terminal-person' }), code('not_yours'))
  await assert.rejects(m.terminals.close('local.b', { terminalId }), code('not_yours'), 'another extension’s')
  assert.deepEqual(await m.terminals.close('local.a', { terminalId }), { closed: true })
  assert.deepEqual(m.killed, [terminalId])
  await assert.rejects(m.terminals.close('local.a', { terminalId }), code('not_yours'), 'it is gone')
})

test('an agent that asks before it runs commands cannot have an extension type or run one for it', async () => {
  const m = machine({ ceiling: 'auto' })
  m.add('terminal-person', {}, 'hello\r\n')
  await assert.rejects(
    m.terminals.send('local.a', { terminalId: 'terminal-person', text: 'ls' }),
    code('not_permitted'),
  )
  await assert.rejects(m.terminals.create('local.a', { workspaceId: 'ws-1', command: 'ls' }), code('not_permitted'))
  // Opening a shell and reading run nothing.
  assert.ok((await m.terminals.create('local.a', { workspaceId: 'ws-1' })).terminalId)
  assert.deepEqual((await m.terminals.read('local.a', { terminalId: 'terminal-person' })).lines, ['hello'])
  m.setCeiling('bypass')
  assert.deepEqual(await m.terminals.send('local.a', { terminalId: 'terminal-person', text: 'ls' }), { accepted: true })
})

test('switched off, it lets go of its terminals and they stay open; uninstalled or killed, they close', async () => {
  const m = machine()
  const first = (await m.terminals.create('local.a', { workspaceId: 'ws-1' })).terminalId
  const second = (await m.terminals.create('local.b', { workspaceId: 'ws-1' })).terminalId
  m.terminals.forget('local.a')
  assert.deepEqual(m.killed, [])
  assert.ok(m.sessions.has(first), 'the person’s now')
  await assert.rejects(m.terminals.close('local.a', { terminalId: first }), code('not_yours'))
  m.terminals.closeAll('local.b')
  assert.deepEqual(m.killed, [second])
  assert.deepEqual(m.terminals.opened('local.b'), [])
})

test('removed while its shell is starting: nothing is kept, nothing typed, and the shell that started closes', async () => {
  const m = machine()
  const spawn = hold()
  m.holdSpawn(spawn.released)
  const creating = m.terminals.create('local.a', { workspaceId: 'ws-1', command: 'npm run build' })
  await Promise.resolve()
  assert.equal(m.spawned.length, 1, 'the shell is starting')
  m.terminals.closeAll('local.a')
  spawn.release()
  await assert.rejects(creating, code('not_permitted'))
  const sessionId = m.spawned[0]!.sessionId
  assert.deepEqual(m.killed, [sessionId], 'the shell that started for it is closed')
  assert.deepEqual(m.terminals.opened('local.a'), [])
  assert.equal(m.sessions.has(sessionId), false)
})

test('switched off while its write waits in the queue: the write is cancelled', async () => {
  const m = machine()
  m.add('t-1')
  const queue = hold()
  m.holdWrites(queue.released)
  const sending = m.terminals.send('local.a', { terminalId: 't-1', text: 'rm -rf build', enter: true })
  m.terminals.forget('local.a')
  queue.release()
  await assert.rejects(sending, code('not_permitted'))
  assert.deepEqual(m.sessions.get('t-1')!.typed, [])
})

test('an approval narrowed while work waits is read again before the shell starts and before each write', async () => {
  const m = machine()
  m.add('t-1')
  let grant: readonly string[] | null = ['terminals:send']
  m.terminals.bindGrants(() => grant)
  const queue = hold()
  m.holdWrites(queue.released)
  const sending = m.terminals.send('local.a', { terminalId: 't-1', text: 'ls', enter: true })
  grant = []
  queue.release()
  await assert.rejects(sending, code('not_permitted'))
  assert.deepEqual(m.sessions.get('t-1')!.typed, [])
  m.holdWrites(null)
  // Revoked before a create starts its shell: none starts.
  grant = null
  await assert.rejects(m.terminals.create('local.a', { workspaceId: 'ws-1' }), code('not_permitted'))
  assert.equal(m.spawned.length, 0)
  grant = ['terminals:send']
  assert.match((await m.terminals.create('local.a', { workspaceId: 'ws-1' })).terminalId, /^terminal-ext-/)
})
