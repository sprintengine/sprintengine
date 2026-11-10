import { describe, expect, it } from 'vitest'

import { sliceWhole } from './slice-whole'
import { sanitizeGeneratedChatTitle } from './text-generation/chat-title'
import { sanitizePullRequestText } from './text-generation/pull-request-text'

describe('sliceWhole', () => {
  it('cuts at max when the cut falls between characters', () => {
    expect(sliceWhole('abcdef', 3)).toBe('abc')
    expect(sliceWhole('ab', 5)).toBe('ab')
  })

  it('drops the first half of a pair the cut would split', () => {
    expect(sliceWhole('ab😀c', 3)).toBe('ab')
    expect(sliceWhole('ab😀c', 4)).toBe('ab😀')
  })
})

describe('titles cut at an emoji', () => {
  it('a generated chat title keeps no half emoji', () => {
    const title = sanitizeGeneratedChatTitle(`${'a'.repeat(41)}😀 more`)
    expect(title).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u)
    expect(title).toBe('A'.concat('a'.repeat(40)))
  })

  it('a pull request title keeps no half emoji', () => {
    const text = sanitizePullRequestText(`${'Fix '.repeat(29)}abc😀 tail`, 'Body')
    expect(text?.title.endsWith('abc')).toBe(true)
  })
})
