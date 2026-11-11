import { expect, test } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { renderMarkdown } from './markdown'

const typed = (text: string) => renderToStaticMarkup(<>{renderMarkdown(text, { userText: true })}</>)

test('a typed message keeps each newline as a line break', () => {
  const html = typed('first line\nsecond line\n\nnext paragraph')
  expect(html).toMatch(/first line<br\/>\s*second line/)
  expect(html.match(/<p/g)).toHaveLength(2)
  // A document still folds a single newline into its paragraph.
  expect(renderToStaticMarkup(<>{renderMarkdown('first line\nsecond line')}</>)).not.toContain('<br')
})

test('HTML in a typed message is shown as the text it is', () => {
  const html = typed('why does <b>this</b> render?\n\n<div class="card">\n  raw\n</div>')
  expect(html).toContain('why does &lt;b&gt;this&lt;/b&gt; render?')
  expect(html).toMatch(/<p[^>]*>&lt;div class=&quot;card&quot;&gt;<br\/>\s*raw<br\/>\s*&lt;\/div&gt;<\/p>/)
  expect(html).not.toContain('<b>')
  expect(html).not.toContain('<div class="card">')
})

test('a pasted fence, a list and inline code are still markdown', () => {
  const html = typed('look:\n\n```ts\nconst a = 1\nconst b = 2\n```\n\n- one\n- two\n\nuse `npm test`')
  expect(html).toContain('<pre')
  expect(html).toContain('const a = 1\nconst b = 2')
  expect(html).not.toContain('const a = 1<br/>')
  expect(html.match(/<li/g)).toHaveLength(2)
  expect(html).toContain('<code')
})

test('a typed ordered list keeps the number written on each item', () => {
  const html = typed('Only these are open:\n\n3. the database\n5. the retry')
  expect(html).toMatch(/<ol[^>]*start="3"/)
  expect(html).toMatch(/<li value="3"[^>]*>[\s\S]*the database/)
  expect(html).toMatch(/<li value="5"[^>]*>[\s\S]*the retry/)
})

test('a typed list written as 1. 1. 1. reads back the way it was typed', () => {
  const html = typed('1. one\n1. two\n1. three')
  expect(html.match(/<li value="1"/g)).toHaveLength(3)
})

test('a document still numbers its list from the first marker', () => {
  const html = renderToStaticMarkup(<>{renderMarkdown('1. one\n1. two\n1. three')}</>)
  expect(html).not.toContain('value=')
})

test('a list nested in a quote keeps its typed numbers too', () => {
  const html = typed('> 2. second\n> 4. fourth')
  expect(html).toMatch(/<li value="2"/)
  expect(html).toMatch(/<li value="4"/)
})
