import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { foldSubagentCrumbs, subagentCrumbs, SubagentViewHeader, type SubagentChatCrumb } from './SubagentChatHost'

const crumbs = (...names: string[]): SubagentChatCrumb[] =>
  names.map((name, depth) => ({ key: depth ? `${depth - 1}` : 'root', name, depth }))

test('the chat and the parent just above stay named, and every step between them folds', () => {
  expect(foldSubagentCrumbs(crumbs('Chat'))).toEqual({ first: crumbs('Chat')[0], folded: [], last: undefined })
  const two = crumbs('Chat', 'Parent')
  expect(foldSubagentCrumbs(two)).toEqual({ first: two[0], folded: [], last: two[1] })
  const four = crumbs('Chat', 'Planner', 'Reviewer', 'Parent')
  expect(foldSubagentCrumbs(four)).toEqual({ first: four[0], folded: [four[1], four[2]], last: four[3] })
})

test('the crumbs are built from the stack the view was reached through', () => {
  const views = [
    { kind: 'chat' as const, agentId: 'a' },
    { kind: 'chat' as const, agentId: 'b' },
  ]
  expect(subagentCrumbs('Chat', views, 2, (view) => `Agent ${view.kind === 'chat' ? view.agentId : ''}`)).toEqual(
    crumbs('Chat', 'Agent a', 'Agent b'),
  )
})

// The band is its own container, and each step is a row link that truncates
// inside its own box: an inline link cannot be narrower than its words, which
// is how the steps of a nested agent's path came to be drawn over each other.
test('a nested sub-agent band truncates each step and folds the middle behind a menu', () => {
  const html = renderToStaticMarkup(
    <SubagentViewHeader
      crumbs={crumbs('Rebuild containers', 'Planner', 'Map agent CLI catalog')}
      name="Audit the sign-in flow"
      facts="Claude Code"
      status="Done in 9m 18s"
      onCrumb={() => undefined}
    />,
  )
  expect(html).toContain('@container')
  expect(html).toContain('‹ Rebuild containers')
  expect(html).toContain('Map agent CLI catalog')
  expect(html).toContain('Audit the sign-in flow')
  // Folded, the step between is a menu item, not a link in the band.
  expect(html).not.toContain('>Planner<')
  expect(html).toContain('aria-label="One more step back up"')
  // Narrow, the chat folds with it.
  expect(html).toContain('aria-label="2 more steps back up"')
  const links = html.match(/<button[^>]*>(?:‹ )?<span class="truncate[^"]*">[^<]*<\/span>/gu) ?? []
  expect(links).toHaveLength(2)
  for (const link of links) expect(link).toContain('flex w-full min-w-0')
})
