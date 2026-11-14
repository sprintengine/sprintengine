import assert from 'node:assert/strict'
import { test } from 'vitest'

import { STUDIO_RESERVED_TOOLSET_NAMES } from '../../../packages/studio-protocol/src/tools'
import { createAutomationTools, type AutomationBackends } from '../../main/automation/automation-tools'
import { SHELL_TOOLSETS, isShellToolName, serverAutomationTools } from './shell-toolsets'

// Out of process the gateway's tools split between the server and the shell's
// toolsets (phase 6, 6.3). The automation tools are all the server's: the
// terminals they launch and read run there (studio-agent-terminals.ts), so an
// agent lists the same tools in either mode, and no family is half on each side.

// Building the registrations reads no backend; only a call would.
const backends = {} as AutomationBackends

test('the server serves every automation tool, the terminal and agent families included', () => {
  const all = createAutomationTools(backends).map((tool) => tool.name)
  const server = serverAutomationTools(backends).map((tool) => tool.name)
  assert.deepEqual([...server].sort(), [...all].sort())
  assert.ok(server.includes('agent.launch') && server.includes('terminal.create') && server.includes('backlog.work'))
})

test('no family is served on both sides', () => {
  const serverFamilies = new Set(serverAutomationTools(backends).map((tool) => tool.name.split('.')[0]))
  for (const name of SHELL_TOOLSETS) assert.equal(serverFamilies.has(name), false, name)
})

test('every shell toolset is a reserved name, so no app can take one', () => {
  for (const name of SHELL_TOOLSETS) assert.ok(STUDIO_RESERVED_TOOLSET_NAMES.includes(name), name)
  assert.equal(isShellToolName('tour.create'), true)
  assert.equal(isShellToolName('agent.launch'), false)
  assert.equal(isShellToolName('backlog.work'), false)
  assert.equal(isShellToolName('tour'), false)
})
