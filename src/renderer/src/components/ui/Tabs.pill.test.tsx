// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'

import { ChipButton } from './ChipButton'
import { Tabs, type TabItem } from './Tabs'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ITEMS: TabItem[] = [
  { id: 'files', label: 'Files' },
  { id: 'browser', label: 'Browser', agent: true },
  { id: 'git', label: 'Git', agent: true },
]

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

function render(node: React.ReactElement): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root?.render(node))
  return host
}

function tab(host: HTMLElement, id: string): HTMLElement {
  const node = host.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)
  if (!node) throw new Error(`no tab ${id}`)
  return node
}

test('the selected tab is the raised pill, the others the same shape without it', () => {
  const host = render(<Tabs ariaLabel="Views" items={ITEMS} value="files" onChange={() => {}} />)
  expect([...tab(host, 'files').classList]).toEqual(expect.arrayContaining(['tab-pill', 'tab-pill--selected']))
  expect(tab(host, 'browser').classList.contains('tab-pill')).toBe(true)
  expect(tab(host, 'browser').classList.contains('tab-pill--selected')).toBe(false)
})

test('a tab draws no underline: selection is the pill', () => {
  const host = render(<Tabs ariaLabel="Views" items={ITEMS} value="files" onChange={() => {}} />)
  expect(host.querySelector('.h-px')).toBeNull()
  expect(tab(host, 'files').className).not.toContain('--accent-primary')
})

test('an agent on the selected tab outlines it, and only an unselected tab takes the wash', () => {
  const host = render(<Tabs ariaLabel="Views" items={ITEMS} value="git" onChange={() => {}} />)
  expect(tab(host, 'git').className).toContain('ring-[color:var(--agent-trail-ink)]')
  expect(tab(host, 'git').className).not.toContain('--agent-trail-soft')
  expect(tab(host, 'browser').className).toContain('--agent-trail-soft')
})

test('the pill does not disturb selection or arrow keys', () => {
  const onChange = vi.fn()
  const host = render(<Tabs ariaLabel="Views" items={ITEMS} value="files" onChange={onChange} />)
  act(() => tab(host, 'git').click())
  expect(onChange).toHaveBeenCalledWith('git')
  onChange.mockClear()
  act(() => tab(host, 'files').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  expect(onChange).toHaveBeenCalledWith('browser')
})

test('a chosen filter pill is the tab pill, and a warning tone keeps its tint', () => {
  const host = render(
    <div>
      <ChipButton variant="pill" selected data-testid="a">
        Installed
      </ChipButton>
      <ChipButton variant="pill" tone="warn" selected data-testid="b">
        Warn
      </ChipButton>
    </div>,
  )
  const chosen = host.querySelector<HTMLElement>('[data-testid="a"]')
  const warn = host.querySelector<HTMLElement>('[data-testid="b"]')
  expect(chosen?.classList.contains('tab-pill--selected')).toBe(true)
  expect(chosen?.className).not.toContain('--bg-selected')
  expect(warn?.classList.contains('tab-pill--selected')).toBe(false)
  expect(warn?.className).toContain('--tone-warn-soft')
})

test('the stylesheet gives FlexLayout tabs the pill and draws no underline for them', () => {
  const css = readFileSync(join(__dirname, '../../assets/index.css'), 'utf8')
  const rule = (selector: string): string => {
    const start = css.indexOf(`${selector} {`)
    expect(start, `missing rule ${selector}`).toBeGreaterThan(-1)
    return css.slice(start, css.indexOf('}', start))
  }
  expect(rule('.flexlayout__layout .flexlayout__tab_button')).toContain('border-radius: var(--sem-radius-pill)')
  expect(rule('.flexlayout__layout .flexlayout__tab_button--selected')).toContain('border-color: var(--border-subtle)')
  expect(css).not.toContain('.flexlayout__tab_button--selected::after')
  expect(css).not.toMatch(/box-shadow: inset 0 -2px 0 #/)
})
