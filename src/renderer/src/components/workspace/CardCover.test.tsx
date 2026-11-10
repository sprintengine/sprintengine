// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'

import { CARD_COVER_CLASS, CardCover } from './CardCover'
import { WorkspaceBandGround } from './WorkspaceBand'
import { WorkspaceAsideColumn } from './workspaceAsideColumn'

// A chat runs to the window's top under its floating pill, so whatever takes the
// card over it has to reach the top too, or the chat shows through the band.

function element(markup: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = markup
  return host.firstElementChild as HTMLElement
}

function classes(node: Element): string[] {
  return node.getAttribute('class')?.split(/\s+/) ?? []
}

test('a cover reaches the window’s top and keeps what it holds below the band', () => {
  const cover = element(
    renderToStaticMarkup(
      <CardCover data-new-chat-door="" className="z-10 bg-[color:var(--agent-surface)]">
        <p>panel</p>
      </CardCover>,
    ),
  )
  expect(classes(cover)).toContain('inset-0')
  expect(cover.className).not.toMatch(/\btop-\[/)
  expect(cover.hasAttribute('data-new-chat-door')).toBe(true)
  expect(classes(cover)).toContain('z-10')
  // The surface's own absolutely placed parts measure from the inner box, which
  // starts below the band, not from the cover.
  const inner = cover.firstElementChild!
  expect(classes(inner)).toContain('relative')
  expect(inner.querySelector('p')?.textContent).toBe('panel')
})

test('what a cover holds starts exactly where the band ends', () => {
  const ground = element(renderToStaticMarkup(<WorkspaceBandGround />))
  const band = classes(ground).find((name) => /^h-\[\d+px\]$/.test(name))
  const clearance = CARD_COVER_CLASS.split(' ').find((name) => /^pt-\[\d+px\]$/.test(name))
  expect(band).toBeDefined()
  expect(clearance?.replace(/^pt-/, 'h-')).toBe(band)
})

test('New chat and a door take the card from the top', () => {
  const source = readFileSync(join(__dirname, 'WorkspaceManager.tsx'), 'utf8')
  // The New chat door (a scheduled agent's editor opens in it) and a door page.
  expect(source).toMatch(/<CardCover\s+data-new-chat-door=""/)
  expect(source).toMatch(/<CardCover\s+ref=\{setSurfaceRegionEl\}/)
  for (const line of source.split('\n')) {
    if (/data-new-chat-door=|ref=\{setSurfaceRegionEl\}/.test(line)) expect(line).not.toMatch(/top-\[36px\]/)
  }
})

test('a maximised pane covers the row from the top, and a docked one stays in its column', () => {
  const render = (props: { fill?: boolean; overlay?: boolean }) =>
    element(
      renderToStaticMarkup(
        <WorkspaceAsideColumn label="Workspace pane" width={360} onWidthChange={() => {}} {...props}>
          <div data-tenant="" className="absolute inset-0" />
        </WorkspaceAsideColumn>,
      ),
    )
  const filling = render({ fill: true })
  for (const name of CARD_COVER_CLASS.split(' ')) expect(classes(filling)).toContain(name)
  expect(filling.className).not.toMatch(/\btop-\[/)
  // The tenant's layers fill the box under the band, not the whole column.
  const tenantBox = filling.querySelector('[data-tenant]')!.parentElement!
  expect(tenantBox).not.toBe(filling)
  expect(classes(tenantBox)).toContain('relative')

  const docked = render({})
  expect(classes(docked)).toContain('h-full')
  expect(classes(docked)).not.toContain('pt-[36px]')
})
