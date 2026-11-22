import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { ExtensionHookEvents, ExtensionHookPoint } from '../../../../packages/extension-sdk/src/hooks'
import { studioPrincipal } from '../../../../packages/studio-protocol/src/permissions'
import { createAgentControlPlane } from '../../../main/agent-control-plane'
import { runAsInvoker, type ExtensionInvoker } from '../../../main/module-host/extension-invocation'
import type { ConversationSessionSummary } from '../../../shared/conversation-runtime'
import type { TerminalSessionSnapshot } from '../../../shared/electron-api'
import { controlPlaneHooks } from './control-plane-hooks'
import type { ExtensionHookOutcome, ExtensionHooks } from './extension-hooks'

// What the agent control plane types to a terminal agent meets
// `agent.prompt.before`, and its raw writes `terminal.write.before`, inside the
// session's queue: a refusal is the send's, naming the extension; a change is
// what is sent; a point nobody hooks sends as before; and the hook runs as the
// extension that asked, else as the agent's starter. A message to a chat is
// checked by the runtime's own door: the plane says what it is.

type Heard = { point: ExtensionHookPoint; event: unknown; invoker: string }

function fakeHooks(
  decide: (point: ExtensionHookPoint, event: Record<string, unknown>) => ExtensionHookOutcome<never> | null,
  listed: readonly ExtensionHookPoint[],
) {
  const heard: Heard[] = []
  const hooks: ExtensionHooks = {
    wants: (point) => listed.includes(point),
    run: async (point, event, invoker) => {
      heard.push({ point, event, invoker: invoker.label })
      // A decision takes a moment, so a queued write could overtake it if the plane let it.
      await new Promise((resolve) => setTimeout(resolve, 20))
      return (decide(point, event as Record<string, unknown>) ?? { kind: 'continue', event }) as never
    },
    notify: () => undefined,
    bind: () => undefined,
  }
  return { hooks, heard }
}

const terminal = (): TerminalSessionSnapshot =>
  ({
    sessionId: 'term-1',
    processAlive: true,
    kind: 'agent',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    cli: 'claude',
    lastOutputAt: null,
    lastInputAt: null,
    agentState: { phase: 'idle', since: 0, source: 'hook' },
  }) as unknown as TerminalSessionSnapshot

const chat = (): ConversationSessionSummary =>
  ({
    sessionId: 'chat-1',
    workspaceId: 'ws-2',
    agentId: 'agent-2',
    providerId: 'claude-agent',
    modelId: 'sonnet',
    status: 'ready',
    createdAt: 0,
    updatedAt: 0,
  }) as ConversationSessionSummary

const starter: ExtensionInvoker = {
  principal: studioPrincipal({ owner: false, permissions: [] }),
  permissionCeiling: 'manual',
  label: 'the chat’s starter',
}

function plane(hooks: ExtensionHooks, chatAnswer: { ok: boolean; message?: string; code?: string } = { ok: true }) {
  const written: string[] = []
  const sent: string[] = []
  const sentAs: unknown[] = []
  const controlPlane = createAgentControlPlane({
    terminal: {
      list: () => [terminal()],
      write: (_sessionId, data) => void written.push(data),
      read: () => '',
    },
    conversation: {
      list: () => [chat()],
      sendTurn: async ({ message, hookAs }) => {
        sentAs.push(hookAs)
        if (!chatAnswer.ok) return chatAnswer
        sent.push(message)
        return chatAnswer
      },
      interrupt: async () => ({ ok: true }),
    },
    delay: async () => undefined,
    hooks: controlPlaneHooks(hooks, () => starter),
  })
  return { controlPlane, written, sent, sentAs }
}

test('a prompt nobody hooks is sent as it was', async () => {
  const { hooks, heard } = fakeHooks(() => null, [])
  const { controlPlane, sent } = plane(hooks)
  assert.equal((await controlPlane.send({ sessionId: 'chat-1' }, 'hello')).ok, true)
  assert.deepEqual(sent, ['hello'])
  assert.deepEqual(heard, [])
})

test('a refused prompt is not sent, and the send says which extension refused it and why', async () => {
  const { hooks, heard } = fakeHooks(
    () => ({
      kind: 'deny',
      extensionId: 'local.quiet-hours',
      displayName: 'Quiet hours',
      reason: 'not now',
      failed: false,
    }),
    ['agent.prompt.before'],
  )
  const refusal = 'The extension "Quiet hours" (local.quiet-hours) refused this: not now'
  // The runtime refuses a chat's message at its own door; the plane passes the refusal on.
  const { controlPlane, sent, written, sentAs } = plane(hooks, {
    ok: false,
    code: 'refused_by_extension',
    message: refusal,
  })
  for (const target of ['chat-1', 'term-1']) {
    const result = await controlPlane.send({ sessionId: target }, 'deploy it')
    assert.deepEqual(result, { ok: false, sessionId: target, reason: 'refused', message: refusal })
  }
  assert.deepEqual(sent, [])
  assert.deepEqual(written, [])
  assert.deepEqual(sentAs, [{ from: 'studio', inputKind: 'notice' }], 'the chat is told what the message is')
  assert.deepEqual(
    heard.map((entry) => entry.event as ExtensionHookEvents['agent.prompt.before']),
    [
      {
        agent: 'claude',
        where: 'terminal',
        workspaceId: 'ws-1',
        agentId: 'agent-1',
        terminalId: 'term-1',
        from: 'studio',
        inputKind: 'notice',
        prompt: 'deploy it',
      },
    ],
  )
  assert.deepEqual(
    heard.map((entry) => entry.invoker),
    ['the chat’s starter'],
  )
})

test('a changed prompt is what the terminal agent is typed, and an extension’s send is the extension’s', async () => {
  const { hooks, heard } = fakeHooks(
    (_point, event) =>
      ({ kind: 'continue', event: { ...event, prompt: `${String(event.prompt)} (reviewed)` } }) as never,
    ['agent.prompt.before'],
  )
  const { controlPlane, written, sent, sentAs } = plane(hooks)
  const extension: ExtensionInvoker = { ...starter, label: 'the extension’s caller' }
  await runAsInvoker(extension, () => controlPlane.send({ sessionId: 'term-1' }, 'ship it'))
  assert.ok(written[0]?.includes('ship it (reviewed)'))
  assert.equal(heard[0]?.invoker, 'the extension’s caller')
  assert.equal((heard[0]?.event as { from: string }).from, 'extension')
  assert.equal((heard[0]?.event as { inputKind: string }).inputKind, 'send')

  // A chat's message goes to the runtime's door marked as the extension's.
  await runAsInvoker(extension, () => controlPlane.send({ sessionId: 'chat-1' }, 'ship it'))
  assert.deepEqual(sent, ['ship it'])
  assert.deepEqual(sentAs, [{ from: 'extension', inputKind: 'send' }])
  assert.equal(heard.length, 1, 'the plane does not hook a chat’s message itself')
})

test('a terminal write waits in its session’s queue while a hook decides, and is changed or refused', async () => {
  const { hooks, heard } = fakeHooks(
    (_point, event) =>
      event.text === 'secret'
        ? { kind: 'deny', extensionId: 'local.guard', displayName: 'Guard', reason: 'no', failed: false }
        : ({
            kind: 'continue',
            // Upper-cased, and Enter pressed only after `two`.
            event: { ...event, text: String(event.text).toUpperCase(), enter: event.text === 'two' },
          } as never),
    ['terminal.write.before'],
  )
  const { controlPlane, written } = plane(hooks)
  const results = await Promise.all([
    controlPlane.write({ sessionId: 'term-1' }, 'one\r'),
    controlPlane.write({ sessionId: 'term-1' }, 'secret\r'),
    controlPlane.write({ sessionId: 'term-1' }, 'two'),
  ])
  assert.deepEqual(written, ['ONE', 'TWO\r'], 'in order, the refused one left out, Enter as the hook left it')
  assert.equal(results[1]?.ok === false && results[1].reason, 'refused')
  // Enter is its own field, split from the text; the write says who typed it.
  assert.deepEqual(heard[0]?.event, {
    terminalId: 'term-1',
    workspaceId: 'ws-1',
    agent: 'claude',
    from: 'studio',
    inputKind: 'notice',
    text: 'one',
    enter: true,
  })
})
