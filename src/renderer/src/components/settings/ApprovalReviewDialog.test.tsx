// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test } from 'vitest'

import type { ThirdPartyModuleView } from '../../../../shared/modules/manifest'
import { ApprovalReviewDialog } from './ApprovalReviewDialog'

// The approval says first what the extension's code can do, for its tier and
// what it asks for: a ui extension's runs isolated, unless it asks to change
// project files, which is full access; a worker's has full access.

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

function view(tier: 'ui' | 'worker', permissions: string[], customEditors: unknown[] = []): ThirdPartyModuleView {
  return {
    approval: { state: 'pending', fingerprint: 'sha256-x' },
    extension: { tier, permissions, contributes: { customEditors } },
    manifest: { id: 'local.deck', displayName: 'Deck' },
    launch: { hasMainEntry: tier === 'worker' },
  } as unknown as ThirdPartyModuleView
}

function shown(module: ThirdPartyModuleView): string {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() =>
    root!.render(
      <ApprovalReviewDialog
        module={module}
        icon={null}
        meta="local · v1"
        care={[]}
        standard={[]}
        busy={false}
        onCancel={() => undefined}
        onApprove={() => undefined}
      />,
    ),
  )
  return document.body.textContent ?? ''
}

test('a ui extension is approved as isolated, and runs code of its own', () => {
  const text = shown(view('ui', ['workspace:read']))
  expect(text).toContain('Its code runs isolated and can do only what you allow')
  expect(text).not.toContain('runs no code of its own')
})

test('a ui extension that may change project files is approved as full access', () => {
  expect(shown(view('ui', ['workspace-files:write']))).toContain('full access to your account on this machine')
})

test('a worker is approved as full access', () => {
  expect(shown(view('worker', []))).toContain('on this machine with full access')
})

test('an extension with a custom editor says which files it opens in it', () => {
  const text = shown(
    view(
      'ui',
      ['workspace-files:read'],
      [{ id: 'todo', title: 'Todo list', entry: 'editor.js', extensions: ['.todo'], filenames: ['TODO'] }],
    ),
  )
  expect(text).toContain('Opens your files in its own editor')
  expect(text).toContain('Todo list: .todo, TODO')
})

test('a local MCP server is approved with its whole command line and environment, and a provider with its key’s origin', () => {
  const module = {
    approval: { state: 'pending', fingerprint: 'sha256-x' },
    extension: {
      tier: 'declarative',
      permissions: [],
      contributes: {
        customEditors: [],
        skills: [{ id: 'review', path: 'skills/review' }],
        mcpServers: [
          {
            id: 'search',
            name: 'Search',
            transport: 'stdio',
            command: 'node',
            args: ['${extensionPath}/dist/server.js', '--root', 'a b'],
            env: [{ name: 'LOG_LEVEL', value: 'info' }],
          },
          { id: 'docs', name: 'Docs', transport: 'http', url: 'https://mcp.example.com/mcp' },
        ],
        providers: [
          {
            id: 'acme',
            name: 'Acme',
            baseUrl: 'https://api.example.com/v1',
            models: [{ id: 'm' }],
            apiKey: { label: 'Acme API key' },
          },
        ],
      },
    },
    manifest: { id: 'local.tools', displayName: 'Tools' },
    launch: { hasMainEntry: false },
  } as unknown as ThirdPartyModuleView
  const text = shown(module)
  expect(text).toContain('Your agents will run its local MCP servers on this machine, with full access')
  expect(text).not.toContain('runs no code of its own')
  expect(text).toContain('Runs node ${extensionPath}/dist/server.js --root "a b"')
  expect(text).toContain('${extensionPath} is the extension’s own folder')
  expect(text).toContain('With LOG_LEVEL=info')
  expect(text).toContain('Reaches https://mcp.example.com/mcp')
  expect(text).toContain('Skill “review”')
  expect(text).toContain('Your key for it is sent to https://api.example.com only')
})

test('hooks are approved as applying to chats on this computer only', () => {
  const module = view('worker', [])
  ;(module.extension.contributes as Record<string, unknown>).hooks = [{ point: 'agent.tool.before', onError: 'deny' }]
  const text = shown(module)
  expect(text).toContain('Hooks into what your agents and Studio do')
  expect(text).toContain('Applies to chats on this computer only, not to chats in WSL or on SSH machines')
})
