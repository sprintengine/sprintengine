import assert from 'node:assert/strict'

import type { MarketplacePluginEntry } from '../../../../shared/marketplace/manifest'
import { componentKindLabels, externalSourceHref } from './storefrontView'
import { test } from 'vitest'

test('storefrontView', async () => {
  function plugin(overrides: Partial<MarketplacePluginEntry> = {}): MarketplacePluginEntry {
    return {
      id: 'review-skills',
      name: 'Review skills',
      publisher: { name: 'Acme', verified: false },
      summary: 'Skills for reviewing a change.',
      category: 'Testing',
      icon: 'icons/review-skills.svg',
      latest: 1,
      source: 'https://github.com/acme/review-skills',
      provides: ['skills'],
      tags: ['claude-plugin'],
      ...overrides,
    }
  }

  {
    // "View source" href guard: http(s) sources pass through unchanged so the
    // link still renders and opens.
    assert.equal(
      externalSourceHref('https://github.com/sprintengine/studio-releases/tree/main/plugins/x'),
      'https://github.com/sprintengine/studio-releases/tree/main/plugins/x',
    )
    assert.equal(externalSourceHref('http://example.com/x'), 'http://example.com/x')
  }

  {
    // Fail closed: non-http(s) schemes that would reach shell.openExternal render
    // no link. Covers file:// / smb:// / an OS protocol-handler scheme.
    assert.equal(externalSourceHref('file:///etc/passwd'), undefined)
    assert.equal(externalSourceHref('smb://host/share'), undefined)
    assert.equal(externalSourceHref('ms-msdt:/id'), undefined)
    // Missing/absent and unparseable sources also fail closed (inline-CLI entries
    // carry no source and must show no link).
    assert.equal(externalSourceHref(undefined), undefined)
    assert.equal(externalSourceHref('not a url'), undefined)
  }

  {
    // Each kind an entry provides reads as its label.
    assert.deepEqual(componentKindLabels(plugin().provides), ['Skill pack'])
    assert.deepEqual(componentKindLabels(['skills', 'cli']), ['Skill pack', 'Agent CLI'])
  }

  console.log('storefrontView.test.ts passed')
})
