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

function view(tier: 'ui' | 'worker', permissions: string[]): ThirdPartyModuleView {
  return {
    approval: { state: 'pending', fingerprint: 'sha256-x' },
    extension: { tier, permissions },
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
