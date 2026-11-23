import { expect, test } from 'vitest'

import { ignoredSkillKeys, projectedSkillText } from './skill-frontmatter'

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
  expect(projectedSkillText(text, 'acme.tools.review')).toBe(
    '---\nname: acme.tools.review\ndescription: >\n  Review a change.\n---\nBody\n',
  )
  expect(ignoredSkillKeys(text)).toEqual(['allowed-tools', 'hooks'])
})

test('a SKILL.md without frontmatter is given its name, and line endings are kept', () => {
  expect(projectedSkillText('Just words.\n', 'acme.tools.words')).toBe(
    '---\nname: acme.tools.words\n---\nJust words.\n',
  )
  expect(projectedSkillText('---\r\nname: a\r\ndescription: b\r\n---\r\nBody\r\n', 'x.y.a')).toBe(
    '---\r\nname: x.y.a\r\ndescription: b\r\n---\r\nBody\r\n',
  )
  expect(ignoredSkillKeys('Just words.\n')).toEqual([])
})
