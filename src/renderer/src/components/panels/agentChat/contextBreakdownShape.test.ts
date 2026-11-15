// The breakdown's picture, worked out apart from its drawing: the bar's
// segments as shares of the window, each row's colour by where it falls, the
// slivers folded into one row, the rows not in the window kept out of the bar
// and said in one line, and which list each category opens to.
import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ConversationContextBreakdown } from '../../../../../shared/conversation-runtime'
import {
  categoryGroup,
  contextPercentLabel,
  contextSegments,
  contextShareLabel,
  deferredLabel,
  deferredRows,
  memoryFileLabel,
} from './contextBreakdownShape'

function breakdown(overrides: Partial<ConversationContextBreakdown> = {}): ConversationContextBreakdown {
  return {
    model: 'claude-sonnet-4-5',
    usedTokens: 60_000,
    windowTokens: 200_000,
    categories: [
      { name: 'System prompt', tokens: 4_000, kind: 'used' },
      { name: 'System tools', tokens: 12_000, kind: 'used' },
      { name: 'MCP tools', tokens: 14_000, kind: 'used' },
      { name: 'MCP tools (deferred)', tokens: 9_000, kind: 'deferred' },
      { name: 'Messages', tokens: 30_000, kind: 'used' },
      { name: 'Free space', tokens: 107_000, kind: 'free' },
      { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
    ],
    mcpServers: [
      { name: 'sprintengine-studio', tokens: 12_000, tools: [] },
      { name: 'linear', tokens: 2_000, tools: [] },
    ],
    skills: [{ name: 'deploy', tokens: 1_200 }],
    memoryFiles: [{ name: '/Users/dev/acme/CLAUDE.md', tokens: 1_900, detail: 'Project' }],
    agents: [],
    autoCompactAt: 167_000,
    estimated: true,
    measuredAt: 0,
    ...overrides,
  }
}

test('segments are shares of the window, deferred rows left out of the bar', () => {
  const segments = contextSegments(breakdown())
  assert.deepEqual(
    segments.map((segment) => [segment.name, segment.share]),
    [
      ['System prompt', 0.02],
      ['System tools', 0.06],
      ['MCP tools', 0.07],
      ['Messages', 0.15],
      ['Free space', 0.535],
      ['Autocompact buffer', 0.165],
    ],
  )
  assert.deepEqual(
    deferredRows(breakdown()).map((row) => row.name),
    ['MCP tools (deferred)'],
  )
})

test('content rows take the chart slots in the order they are drawn; free space and the buffer take none', () => {
  const slots = (b: ConversationContextBreakdown) => contextSegments(b).map((segment) => [segment.name, segment.slot])
  assert.deepEqual(slots(breakdown()), [
    ['System prompt', 1],
    ['System tools', 2],
    ['MCP tools', 3],
    ['Messages', 4],
    ['Free space', null],
    ['Autocompact buffer', null],
  ])
})

test('past the eighth content row the rest fold into the grey', () => {
  const rows = Array.from({ length: 9 }, (_, index) => ({
    name: `Row ${index + 1}`,
    tokens: 10,
    kind: 'used' as const,
  }))
  const segments = contextSegments(breakdown({ windowTokens: 90, categories: rows }))
  assert.deepEqual(
    segments.map((segment) => segment.slot),
    [1, 2, 3, 4, 5, 6, 7, 8, 'other'],
  )
})

test('a window read over its limit is drawn against the rows’ own sum, so the bar never overruns', () => {
  const segments = contextSegments(
    breakdown({
      windowTokens: 100,
      categories: [
        { name: 'Messages', tokens: 150, kind: 'used' },
        { name: 'Free space', tokens: 0, kind: 'free' },
      ],
    }),
  )
  assert.equal(segments[0]!.share, 1)
  assert.equal(
    segments.reduce((sum, segment) => sum + segment.share, 0),
    1,
  )
})

test('rows under 1% of the window fold into one grey row where the first of them was, heaviest first inside', () => {
  const segments = contextSegments(
    breakdown({
      windowTokens: 1_000_000,
      categories: [
        { name: 'System prompt', tokens: 2_100, kind: 'used' },
        { name: 'System tools', tokens: 13_100, kind: 'used' },
        { name: 'Skills', tokens: 5_800, kind: 'used' },
        { name: 'Messages', tokens: 251_000, kind: 'used' },
        { name: 'Free space', tokens: 728_000, kind: 'free' },
      ],
    }),
  )
  assert.deepEqual(
    segments.map((segment) => [segment.name, segment.tokens, segment.slot]),
    [
      ['2 more under 1%', 7_900, 'other'],
      ['System tools', 13_100, 1],
      ['Messages', 251_000, 2],
      ['Free space', 728_000, null],
    ],
  )
  assert.deepEqual(
    segments[0]!.members!.map((member) => member.name),
    ['Skills', 'System prompt'],
  )
  assert.ok(Math.abs(segments[0]!.share - 0.0079) < 1e-9, 'the folded row is drawn as wide as its rows together')
})

test('a single sliver stays itself: a row that opens to one row says nothing', () => {
  const segments = contextSegments(
    breakdown({
      windowTokens: 1_000_000,
      categories: [
        { name: 'System prompt', tokens: 2_100, kind: 'used' },
        { name: 'Messages', tokens: 251_000, kind: 'used' },
      ],
    }),
  )
  assert.deepEqual(
    segments.map((segment) => [segment.name, segment.members === undefined]),
    [
      ['System prompt', true],
      ['Messages', true],
    ],
  )
})

test('a category opens to the list it names; a name it does not know opens to nothing', () => {
  assert.equal(categoryGroup('MCP tools'), 'mcp')
  assert.equal(categoryGroup('Skills'), 'skills')
  assert.equal(categoryGroup('Memory files'), 'memory')
  assert.equal(categoryGroup('Custom agents'), 'agents')
  assert.equal(categoryGroup('MCP tools (deferred)'), null)
  assert.equal(categoryGroup('Messages'), null)
})

test('the rows not in the window read as one line, without the agent’s "(deferred)"', () => {
  assert.equal(
    deferredLabel([
      { name: 'MCP tools (deferred)', tokens: 110_000 },
      { name: 'System tools (deferred)', tokens: 26_700 },
    ]),
    'MCP tools 110k · System tools 26.7k',
  )
})

test('a share under 1% has no number of its own: the tokens say enough', () => {
  assert.equal(contextPercentLabel(251_000, 1_000_000), '25%')
  assert.equal(contextPercentLabel(13_100, 1_000_000), '1%')
  assert.equal(contextPercentLabel(2_100, 1_000_000), null)
  assert.equal(contextPercentLabel(10, 0), null)
})

test('shares read in whole percent, with a floor that is not zero', () => {
  assert.equal(contextShareLabel(76_000, 200_000), '38%')
  assert.equal(contextShareLabel(300, 200_000), '<1%')
  assert.equal(contextShareLabel(0, 200_000), '0%')
  assert.equal(contextShareLabel(10, 0), '0%')
})

test('a memory file’s path is cut to what tells two apart', () => {
  assert.equal(memoryFileLabel('/Users/dev/acme/CLAUDE.md'), '…/acme/CLAUDE.md')
  assert.equal(memoryFileLabel('C:\\Users\\dev\\.claude\\CLAUDE.md'), '…/.claude/CLAUDE.md')
  assert.equal(memoryFileLabel('CLAUDE.md'), 'CLAUDE.md')
})
