import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { ExtensionOpenRequest, ExtensionOpenOutcome } from '../../shared/extension-open'
import type { McpConnectionContext, McpToolResult } from '../../shared/modules/mcp-tools'
import type { ModuleLifecycle } from '../modules/module-lifecycle'
import { createExtensionInstallTools, EXTENSION_INSTALL_TOOL_NAMES } from './extension-install-tools'

// Installing, updating and opening from outside the window: each source form
// reaches the install path Settings takes, refusals keep their codes, nothing
// approves, a capped agent's install waits for the person as anyone's does,
// a paired device is refused, and with no window `open` says so.

type Seen = {
  installKey: string[]
  installFrom: unknown[]
  updateNow: Array<string | undefined>
  askReview: string[]
  approve: number
  opened: ExtensionOpenRequest[]
}

const pending = { state: 'pending', fingerprint: 'sha256-x' } as const

function view(over: Record<string, unknown> = {}) {
  return {
    manifest: { id: 'acme.notes' },
    approval: { state: 'approved', fingerprint: 'sha256-x' },
    extension: {
      contributes: {
        panels: [
          { id: 'main', title: 'Notes' },
          { id: 'side', title: 'Side' },
        ],
        customEditors: [{ id: 'board', title: 'Board', extensions: ['.board'] }],
      },
    },
    ...over,
  }
}

function tools(
  options: {
    answer?: Record<string, unknown>
    module?: Record<string, unknown>
    enabled?: boolean
    open?: (request: ExtensionOpenRequest) => Promise<ExtensionOpenOutcome>
  } = {},
) {
  const seen: Seen = { installKey: [], installFrom: [], updateNow: [], askReview: [], approve: 0, opened: [] }
  const answer = options.answer ?? { ok: true, moduleId: 'acme.notes', approval: pending, strippedLinks: [] }
  const lifecycle = {
    catalogue: {
      installKey: async (key: string) => {
        seen.installKey.push(key)
        return { ...answer, catalogue: 'community' }
      },
      installFrom: async (from: unknown) => {
        seen.installFrom.push(from)
        return answer
      },
      updateNow: async (key?: string) => {
        seen.updateNow.push(key)
        return [{ key: key ?? 'acme.notes', from: '1.0.0', status: 'up_to_date' }]
      },
    },
    askReview: (key: string) => seen.askReview.push(key),
    approve: async () => {
      seen.approve += 1
      return { ok: true }
    },
    installed: async () => ({ modules: [view(options.module)], rejected: [] }),
    list: () => [{ id: 'acme.notes', enabled: options.enabled ?? true }],
  } as unknown as ModuleLifecycle
  const open =
    options.open ??
    (async (request: ExtensionOpenRequest): Promise<ExtensionOpenOutcome> => {
      seen.opened.push(request)
      return { ok: true, workspaceId: 'ws-1' }
    })
  const registrations = createExtensionInstallTools({
    backend: () => ({ lifecycle: () => lifecycle }),
    openInWindow: async (request) => {
      if (!options.open) return open(request)
      seen.opened.push(request)
      return open(request)
    },
  })
  return { seen, tool: (name: string) => registrations.find((tool) => tool.name === name)! }
}

const local: McpConnectionContext = { metadata: { kind: 'external-local' } }
const agent: McpConnectionContext = {
  metadata: { kind: 'studio-agent', agentId: 'a', workspaceId: 'w', verified: true },
}
const device: McpConnectionContext = { metadata: { kind: 'remote-tailnet', deviceId: 'd', verified: true } }
const codeOf = (result: McpToolResult) => (result.structuredContent as { error?: { code: string } }).error?.code

test('the three tools, by name; a paired device is refused each', async () => {
  const { tool } = tools()
  for (const name of EXTENSION_INSTALL_TOOL_NAMES) {
    const answer = await tool(name).handler({ source: 'acme.notes', moduleId: 'acme.notes', all: false }, device)
    assert.equal(codeOf(answer), 'not_permitted', name)
  }
})

test('each source form reaches the install path Settings takes', async () => {
  const { seen, tool } = tools()
  const install = tool('extension.install')
  await install.handler({ source: 'acme.notes' }, local)
  await install.handler({ source: 'acme/notes@v1' }, local)
  await install.handler({ source: 'https://git.example.com/acme/notes.git#main' }, local)
  await install.handler({ source: 'https://github.com/acme/tools/tree/main/notes' }, local)
  assert.deepEqual(seen.installKey, ['acme.notes'])
  assert.deepEqual(seen.installFrom, [
    { git: 'https://github.com/acme/notes.git', ref: 'v1' },
    { git: 'https://git.example.com/acme/notes.git', ref: 'main' },
    { git: 'https://github.com/acme/tools.git', ref: 'main', path: 'notes' },
  ])
  assert.equal(codeOf(await install.handler({ source: 'notes' }, local)), 'invalid_arguments')
})

test('an install that runs code waits for the person, whose window asks; nothing here approves, for an agent either', async () => {
  const { seen, tool } = tools()
  const install = tool('extension.install')
  for (const caller of [local, agent]) {
    const answer = await install.handler({ source: 'acme.notes' }, caller)
    assert.notEqual(answer.isError, true)
    assert.deepEqual((answer.structuredContent as { approval: unknown }).approval, pending)
  }
  assert.deepEqual(seen.askReview, ['acme.notes', 'acme.notes'])
  assert.equal(codeOf(await install.handler({ source: 'acme.notes', approve: 'sha256-x' }, local)), 'invalid_arguments')
  assert.equal(seen.approve, 0)
})

test('what is ready at once asks nobody', async () => {
  const { seen, tool } = tools({
    answer: { ok: true, moduleId: 'acme.notes', approval: { state: 'not-needed' }, strippedLinks: [] },
  })
  await tool('extension.install').handler({ source: 'acme.notes' }, local)
  assert.deepEqual(seen.askReview, [])
})

test('a refusal keeps its code', async () => {
  for (const code of ['killed', 'release_lock_mismatch', 'owner_mismatch']) {
    const { tool } = tools({ answer: { ok: false, code, message: code } })
    assert.equal(codeOf(await tool('extension.install').handler({ source: 'acme.notes' }, local)), code)
  }
  const { tool } = tools({ answer: { ok: false, message: 'no' } })
  assert.equal(codeOf(await tool('extension.install').handler({ source: 'acme.notes' }, local)), 'install_failed')
})

test('update names one extension or all of them', async () => {
  const { seen, tool } = tools()
  const update = tool('extension.update')
  assert.notEqual((await update.handler({ all: true }, local)).isError, true)
  assert.notEqual((await update.handler({ moduleId: 'acme.notes' }, local)).isError, true)
  assert.deepEqual(seen.updateNow, [undefined, 'acme.notes'])
  assert.equal(codeOf(await update.handler({}, local)), 'invalid_arguments')
  assert.equal(codeOf(await update.handler({ moduleId: 'acme.notes', all: true }, local)), 'invalid_arguments')
})

test('open shows a panel, the first by default, or a file in the editor that takes it', async () => {
  const { seen, tool } = tools()
  const open = tool('extension.open')
  assert.notEqual((await open.handler({ moduleId: 'acme.notes' }, local)).isError, true)
  assert.notEqual((await open.handler({ moduleId: 'acme.notes', panel: 'side' }, local)).isError, true)
  assert.notEqual(
    (await open.handler({ moduleId: 'acme.notes', editor: '/Users/dev/plan.board' }, local)).isError,
    true,
  )
  assert.deepEqual(seen.opened, [
    { moduleId: 'acme.notes', panel: 'main', title: 'Notes' },
    { moduleId: 'acme.notes', panel: 'side', title: 'Side' },
    { moduleId: 'acme.notes', file: '/Users/dev/plan.board', editor: 'board', title: 'Board' },
  ])
  assert.equal(codeOf(await open.handler({ moduleId: 'acme.notes', panel: 'nope' }, local)), 'not_found')
  assert.equal(codeOf(await open.handler({ moduleId: 'acme.notes', editor: '/Users/dev/a.txt' }, local)), 'not_found')
  assert.equal(codeOf(await open.handler({ moduleId: 'acme.notes', editor: 'plan.board' }, local)), 'invalid_arguments')
})

test('open refuses with no window, no workspace, and what does not run', async () => {
  const none = createExtensionInstallTools({
    backend: () => ({
      lifecycle: () =>
        ({
          installed: async () => ({ modules: [view()], rejected: [] }),
          list: () => [],
        }) as unknown as ModuleLifecycle,
    }),
  }).find((tool) => tool.name === 'extension.open')!
  assert.equal(codeOf(await none.handler({ moduleId: 'acme.notes' }, local)), 'no_window')
  const noWorkspace = tools({
    open: async () => ({ ok: false, code: 'no_workspace', message: 'No window shows a workspace.' }),
  })
  assert.equal(
    codeOf(await noWorkspace.tool('extension.open').handler({ moduleId: 'acme.notes' }, local)),
    'no_workspace',
  )
  const waiting = tools({ module: { approval: pending } })
  assert.equal(
    codeOf(await waiting.tool('extension.open').handler({ moduleId: 'acme.notes' }, local)),
    'approval_required',
  )
  assert.deepEqual(waiting.seen.opened, [])
  const off = tools({ enabled: false })
  assert.equal(
    codeOf(await off.tool('extension.open').handler({ moduleId: 'acme.notes' }, local)),
    'extension_unavailable',
  )
  const killed = tools({ module: { killed: { reason: 'bad' } } })
  assert.equal(
    codeOf(await killed.tool('extension.open').handler({ moduleId: 'acme.notes' }, local)),
    'extension_unavailable',
  )
})
