import { expect, test } from 'vitest'

import { extensionSkillName, ignoredSkillKeys, projectedSkillText } from './skill-frontmatter'

test('only the description is kept, under the namespaced name, and the dropped keys are listed', () => {
  const text = [
    '---',
    'name: review',
    'description: >',
    '  Review a change.',
    'allowed-tools:',
    '  - Bash(*)',
    'hooks:',
    '  Stop:',
    '    - command: run',
    '---',
    'Body',
    '',
  ].join('\n')
  expect(projectedSkillText(text, 'x1a2b3c4d-review')).toBe(
    '---\nname: x1a2b3c4d-review\ndescription: >\n  Review a change.\n---\nBody\n',
  )
  expect(ignoredSkillKeys(text)).toEqual(['allowed-tools', 'hooks'])
})

test('a SKILL.md without frontmatter is given its name, and line endings are kept', () => {
  expect(projectedSkillText('Just words.\n', 'x1a2b3c4d-words')).toBe('---\nname: x1a2b3c4d-words\n---\nJust words.\n')
  expect(projectedSkillText('---\r\nname: a\r\ndescription: b\r\n---\r\nBody\r\n', 'x1a2b3c4d-a')).toBe(
    '---\r\nname: x1a2b3c4d-a\r\ndescription: b\r\n---\r\nBody\r\n',
  )
  expect(ignoredSkillKeys('Just words.\n')).toEqual([])
})

test('a skill’s name follows the Agent Skills naming rule, is stable, and differs between extensions', () => {
  const RULE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
  const review = extensionSkillName('acme.tools', 'review')
  expect(review).toMatch(/^x[0-9a-f]{8}-review$/)
  expect(extensionSkillName('acme.tools', 'review')).toBe(review)
  expect(extensionSkillName('acme.checks', 'review')).not.toBe(review)
  // The longest skill id an extension may give is cut to fit, never with a trailing hyphen.
  const long = `${'a'.repeat(53)}-${'b'.repeat(9)}`
  const cut = extensionSkillName('acme.tools', long)
  expect(cut.length).toBeLessThanOrEqual(64)
  expect(cut).toMatch(RULE)
  expect(cut).not.toBe(extensionSkillName('acme.tools', `${'a'.repeat(53)}-${'c'.repeat(9)}`))
  for (const name of [review, cut]) expect(name).toMatch(RULE)
})
