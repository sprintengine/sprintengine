// @vitest-environment jsdom
// Text, content and feedback: what a panel shows, in the app's own type, tones
// and blocks. Links open only through Studio, and only once they stood still.

import { afterEach, expect, test, vi } from 'vitest'

import { cb, click, draw, n, settle, type Drawn } from './componentsTestKit'

let drawn: Drawn | null = null
afterEach(() => {
  drawn?.unmount()
  drawn = null
  vi.restoreAllMocks()
})

test('text takes a tone, a size, a weight and inline children', () => {
  drawn = draw(
    n('Text', { tone: 'danger', size: 'sm', weight: 'semibold' }, [
      'Failed: ',
      n('Code', {}, ['exit 1'], 'c'),
      ' ',
      n('Badge', { tone: 'warning' }, ['retrying'], 'b'),
    ]),
  )
  const text = drawn.host.querySelector<HTMLElement>('span')!
  expect(text.className).toContain('text-meta')
  expect(text.className).toContain('font-semibold')
  expect(text.style.color).toContain('--tone-error')
  expect(drawn.host.querySelector('code')!.textContent).toBe('exit 1')
  expect(drawn.host.textContent).toContain('retrying')
})

test('headings sit below the panel title', () => {
  drawn = draw(n('Stack', {}, [n('Heading', { level: 1 }, ['Top'], 'a'), n('Heading', { level: 3 }, ['Small'], 'b')]))
  expect(drawn.host.querySelector('h3')!.textContent).toBe('Top')
  expect(drawn.host.querySelector('h5')!.textContent).toBe('Small')
})

test('a link opens its href only once it stood still, and runs onPress without a second gesture', () => {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  drawn = draw(n('Link', { href: 'https://example.com/docs', onPress: cb('pressed') }, ['Docs']))
  const link = drawn.host.querySelector('button')!
  click(link)
  expect(drawn.opened).toEqual([])
  expect(drawn.sent).toEqual([])
  now = 600
  click(link)
  expect(drawn.opened).toEqual(['https://example.com/docs'])
  expect(drawn.sent).toEqual([{ callback: 'pressed', args: [] }])
  expect(drawn.grants).toBe(0)
})

test('markdown is drawn through the safe renderer, and its links open only through Studio', () => {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  drawn = draw(n('Markdown', { content: '# Notes\n\nSee [the guide](https://example.com/g) and <script>x</script>.' }))
  expect(drawn.host.querySelector('script')).toBeNull()
  expect(drawn.host.textContent).toContain('Notes')
  const link = [...drawn.host.querySelectorAll('button')].find((each) => each.textContent === 'the guide')!
  click(link)
  expect(drawn.opened).toEqual([])
  now = 600
  click(link)
  expect(drawn.opened).toEqual(['https://example.com/g'])
})

test('code view, key-value and callout use the app’s blocks', () => {
  drawn = draw(
    n('Stack', {}, [
      n('CodeView', { code: 'const a = 1', language: 'ts', label: 'a.ts' }, [], 'code'),
      n(
        'KeyValue',
        {
          items: [
            { label: 'Status', value: 'ok', tone: 'success' },
            { label: 'Port', value: 8080, code: true },
          ],
        },
        [],
        'kv',
      ),
      n('Callout', { tone: 'danger', title: 'Broken' }, ['Fix it'], 'callout'),
    ]),
  )
  expect(drawn.host.textContent).toContain('const a = 1')
  expect(drawn.host.querySelector('dl')!.textContent).toContain('8080')
  const alert = drawn.host.querySelector('[role="alert"]')!
  expect(alert.textContent).toContain('Broken')
  expect(alert.textContent).toContain('Fix it')
})

test('an image comes from the extension’s files, and draws a placeholder when it cannot', async () => {
  drawn = draw(
    n('Stack', {}, [
      n('Image', { src: 'assets/logo.png', alt: 'Logo' }, [], 'a'),
      n('Image', { src: 'assets/missing.png', alt: 'Missing' }, [], 'b'),
    ]),
    { images: { 'assets/logo.png': 'data:image/png;base64,AAAA' } },
  )
  await settle()
  expect(drawn.host.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,AAAA')
  expect(drawn.host.querySelector('[data-image-placeholder]')!.getAttribute('aria-label')).toBe('Missing')
})

test('relative time, skeleton, spinner, progress and an empty state', () => {
  const at = Date.now() - 5 * 60_000
  drawn = draw(
    n('Stack', {}, [
      n('RelativeTime', { at, format: 'long' }, [], 't'),
      n('Skeleton', { lines: 2 }, [], 's'),
      n('Spinner', { label: 'Fetching' }, [], 'sp'),
      n('Progress', { label: 'Upload', value: 40 }, [], 'p'),
      n('EmptyState', { title: 'No deploys', description: 'Push to start' }, [n('Button', {}, ['Push'], 'b')], 'e'),
    ]),
  )
  expect(drawn.host.querySelector('time')!.textContent).toBe('5 minutes ago')
  expect(drawn.host.querySelector('[role="status"][aria-label="Loading"]')).not.toBeNull()
  expect(drawn.host.querySelector('[aria-label="Fetching"]')).not.toBeNull()
  expect(drawn.host.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('40')
  expect(drawn.host.textContent).toContain('No deploys')
  expect(drawn.host.textContent).toContain('Push')
})
