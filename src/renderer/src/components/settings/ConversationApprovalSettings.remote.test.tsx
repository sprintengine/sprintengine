// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test } from 'vitest'

import { StudioError } from '../../../../../packages/client-runtime/src/public'
import { fakePairedStudios } from '../../studio/environmentStudio.double'
import { ConversationApprovalSettings } from './ConversationApprovalSettings'

// Settings lists the "always allow" rules each paired machine's chats run
// with beside this computer's, and revokes one there.

test('a paired machine’s rules are listed under it, and revoked there', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // Each machine's rules as its Studio keeps them, a project by its folder.
  let rules = [
    {
      id: 'r1',
      label: 'Run npm test',
      toolName: 'Bash',
      toolKind: 'command',
      workspaceRoot: '/Users/dev/parser',
      createdAt: 1,
    },
  ]
  const api = {
    conversationApprovalRules: async () => ({ ok: true, rules: [] }),
    meshListConnections: async () => [
      { id: 'c1', machineName: 'mac-mini' },
      { id: 'c2', machineName: 'build-box' },
    ],
  }
  ;(window as unknown as { api: unknown }).api = api
  const studio = fakePairedStudios(api, {
    'conversation.approvalRules': (_params, connectionId) => {
      // build-box's Studio is from before the rules were shared.
      if (connectionId !== 'c1') throw new StudioError('unknown_method', 'No such method.')
      return { ok: true, rules }
    },
    'conversation.revokeApprovalRule': () => {
      rules = []
      return { ok: true }
    },
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(<ConversationApprovalSettings />))
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  expect(host.textContent).toContain('On mac-mini')
  expect(host.textContent).toContain('Run npm test')
  expect(host.textContent).toContain('parser')
  expect(host.textContent).toContain('build-box does not share its chat permissions yet.')
  const revoke = host.querySelector<HTMLButtonElement>('button[aria-label="Revoke Run npm test on mac-mini"]')
  await act(async () => revoke!.click())
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  expect(studio.writes()).toEqual([
    { connectionId: 'c1', method: 'conversation.revokeApprovalRule', params: { ruleId: 'r1' } },
  ])
  expect(host.textContent).toContain('No workspace permissions have been remembered there.')
  await act(async () => root.unmount())
  host.remove()
})
