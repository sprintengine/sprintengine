import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'vitest'

import { ExtensionTrustReview, type ExtensionTrustReviewData } from './ExtensionTrustReview'

test('the review lists every skill the install would put in the workspace', () => {
  const review: ExtensionTrustReviewData = {
    classification: 'unsigned',
    permissions: [],
    files: ['skills/review', 'skills/triage'],
    sourceUrl: 'https://github.com/acme/skills',
  }
  const html = renderToStaticMarkup(<ExtensionTrustReview {...review} publisher={{ name: 'Acme', verified: false }} />)
  assert.match(html, /Unsigned plugin skills/)
  assert.match(html, /skills\/review/)
  assert.match(html, /skills\/triage/)
  assert.match(html, /Adds 2 skills to the workspace/)
  assert.match(html, /publisher not verified/)
  // Skills are files, not access: no permission list is drawn for them.
  assert.doesNotMatch(html, /Access it requests/)
})

test('an unsigned review says it is not signed', () => {
  const review: ExtensionTrustReviewData = { classification: 'unsigned', permissions: [], files: ['skills/review'] }
  const html = renderToStaticMarkup(<ExtensionTrustReview {...review} />)
  assert.match(html, /None — not signed/)
})
