import assert from 'node:assert/strict'
import { test } from 'vitest'

import { containerAgentFor, IMAGE_BASE_COMMANDS, imageFor } from './container-image'

// The image a container gets, as Studio writes it from the agents set up on
// this computer (docs/design/container-chats.md): a pinned base, one layer per
// agent in a fixed order, pinned npm versions, scripts outside the home.

test('one layer per agent, in a fixed order whatever order they were set up in, after a pinned base', () => {
  const one = imageFor(['codex', 'claude-code'])
  const other = imageFor(['claude-code', 'codex'])
  assert.equal(one.tag, other.tag, 'the same set is the same image')
  assert.match(one.tag, /^sprintengine-studio-agent:[a-f0-9]{12}$/u)
  assert.match(one.dockerfile, /^FROM node:22-bookworm-slim@sha256:[a-f0-9]{64}$/mu)
  const layers = one.dockerfile.split('\n').filter((line) => line.startsWith('RUN npm install -g'))
  assert.deepEqual(layers, [
    'RUN npm install -g "@anthropic-ai/claude-code@2.1.325" && npm cache clean --force',
    'RUN npm install -g "@openai/codex@0.169.0" && npm cache clean --force',
  ])
  assert.deepEqual(
    one.agents.map((agent) => `${agent.name} ${agent.version}`),
    ['Claude Code 2.1.325', 'Codex 0.169.0'],
  )
  // A changed set is another image; the base it starts from is the same.
  const more = imageFor(['codex', 'claude-code', 'grok'])
  assert.notEqual(more.tag, one.tag)
  assert.ok(more.dockerfile.startsWith(one.dockerfile.split('RUN npm install -g')[0]!))
})

test('the GitHub CLI is checked against its published digest, and nothing secret is built in', () => {
  const { dockerfile } = imageFor(['claude-code'])
  assert.match(dockerfile, /sha256sum -c -/u)
  assert.match(dockerfile, /gh_2\.83\.1_linux_\$arch\.tar\.gz/u)
  assert.doesNotMatch(dockerfile, /TOKEN|API_KEY|\.credentials/u)
  // Where the logins volume mounts belongs to the agent's user; Studio fills it after each start.
  assert.match(dockerfile, /^RUN mkdir -p \/studio-logins && chown node:node \/studio-logins$/mu)
})

test('an agent with only an install script gets its newest build, under /opt, and says so', () => {
  const image = imageFor(['cursor', 'kimi-code', 'muse'])
  assert.match(
    image.dockerfile,
    /^RUN mkdir -p \/opt\/cursor && HOME=\/opt\/cursor bash -o pipefail -c 'curl -fsS https:\/\/cursor\.com\/install \| bash' <\/dev\/null && ln -sf \/opt\/cursor\/\.local\/bin\/cursor-agent \/usr\/local\/bin\/cursor-agent && chmod -R a\+rX \/opt\/cursor$/mu,
  )
  assert.match(image.dockerfile, /ln -sf \/opt\/kimi-code\/\.kimi-code\/bin\/kimi \/usr\/local\/bin\/kimi/u)
  assert.match(image.dockerfile, /ln -sf \/opt\/muse\/\.local\/bin\/muse \/usr\/local\/bin\/muse/u)
  assert.deepEqual(
    image.agents.map((agent) => agent.version),
    [
      'the newest when the image was built',
      'the newest when the image was built',
      'the newest when the image was built',
    ],
  )
  assert.deepEqual(image.refused, [])
})

test('an agent set up in Studio is found by the command it runs, and one with no Linux build is said', () => {
  assert.equal(containerAgentFor('claude'), 'claude-code')
  assert.equal(containerAgentFor('cursor-agent'), 'cursor')
  assert.equal(containerAgentFor('kimi'), 'kimi-code')
  assert.equal(containerAgentFor('some-desktop-only-agent'), null)
  // A plain shell agent needs nothing installed.
  assert.ok(IMAGE_BASE_COMMANDS.has('sh'))
  const image = imageFor(['codex'], ['Desktop Agent'])
  assert.deepEqual(image.refused, [
    { cli: 'Desktop Agent', why: 'Desktop Agent has no Linux build Studio can install, so a container cannot run it.' },
  ])
})
