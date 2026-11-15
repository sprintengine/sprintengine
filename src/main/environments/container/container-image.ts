import { createHash } from 'node:crypto'

import type { ContainerImagePlan } from '../../../shared/containers'
import { LOGINS_ROOT } from './container-logins'

// Studio's image for a container (docs/design/container-chats.md): written
// here from the agents the person has set up in Studio, at the versions this
// build of Studio pins, built on the container's host the first time it is
// needed there, and tagged by a digest of what went into it. Docker keeps it,
// so every later container on that host with the same agents starts at once,
// and a changed set of agents (or an app update that moves a version) builds
// a new one beside the old (the old one is Docker's to prune, never Studio's).
//
// One layer per agent, in a fixed order after the base, so adding or
// dropping an agent rebuilds only the layers after it.

export const IMAGE_REPOSITORY = 'sprintengine-studio-agent'

/** An image a container runs: its plan (tag, agents, the ones left out) and the Dockerfile that builds it. */
export type ContainerImage = ContainerImagePlan & { dockerfile: string }

/**
 * Node 22 on Debian, pinned by digest (the multi-platform index), so the image a
 * digest names is the same wherever it is built; moved on purpose, with the CLIs.
 */
const BASE_IMAGE = 'node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee'

/** The GitHub CLI: a release archive checked against its published SHA-256 for each architecture. */
const GH = {
  version: '2.83.1',
  sha256: {
    amd64: '1c5252d4ce3db07b51c01ff0b909583da6364ff3fdc06d0c2e75e62dc0380a34',
    arm64: '36af472f8e96fd67253f813f71d9610624cc4e3c7a5b148459e42ffa1a933f64',
  },
}

/**
 * How each agent CLI gets into a container: an npm package at the version this
 * build of Studio pins, or the CLI's own install script, which takes its newest
 * build when the image is built (said so where the image's agents are listed).
 * A script installs under a directory of its own in /opt, outside the home
 * (a volume, which a new image would never reach), and its command is linked
 * onto PATH.
 */
type AgentRecipe = { cli: string; name: string; binary: string } & (
  { npm: string; version: string } | { script: string; dir: string; linkFrom: string }
)

const AGENTS: readonly AgentRecipe[] = [
  { cli: 'claude-code', name: 'Claude Code', npm: '@anthropic-ai/claude-code', version: '2.1.325', binary: 'claude' },
  { cli: 'codex', name: 'Codex', npm: '@openai/codex', version: '0.169.0', binary: 'codex' },
  { cli: 'opencode', name: 'OpenCode', npm: 'opencode-ai', version: '1.19.5', binary: 'opencode' },
  { cli: 'grok', name: 'Grok', npm: '@xai-official/grok', version: '1.0.77', binary: 'grok' },
  {
    cli: 'cursor',
    name: 'Cursor',
    script: 'curl -fsS https://cursor.com/install | bash',
    dir: 'cursor',
    binary: 'cursor-agent',
    linkFrom: '.local/bin/cursor-agent',
  },
  {
    cli: 'kimi-code',
    name: 'Kimi Code',
    script: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
    dir: 'kimi-code',
    binary: 'kimi',
    linkFrom: '.kimi-code/bin/kimi',
  },
  {
    cli: 'muse',
    name: 'Muse',
    script: 'curl -fsSL https://dev.meta.ai/install.sh | bash',
    dir: 'muse',
    binary: 'muse',
    linkFrom: '.local/bin/muse',
  },
]

/**
 * The agent a container gets for one set up in Studio, by the command it runs:
 * an agent built on another's command (a chat provider on Claude Code's, say)
 * is that one. Null when Studio has no Linux install of that command.
 */
export function containerAgentFor(binary: string): string | null {
  return AGENTS.find((agent) => agent.binary === binary)?.cli ?? null
}

/** Commands every image has already (a plain shell agent runs `sh`): nothing to install, nothing to refuse. */
export const IMAGE_BASE_COMMANDS: ReadonlySet<string> = new Set(['sh', 'bash', 'node', 'npm', 'git', 'gh'])

/**
 * The image for the agent CLIs set up on this computer: each registered agent
 * whose command was found (`installed`, keyed by its id), by the command it
 * runs. One whose check gave no answer (it failed, or the CLI was being
 * updated) refuses the lot, in words: an image of a guess would differ from
 * the next one and offer a Rebuild for nothing.
 */
export function imageForSetUp(
  entries: ReadonlyArray<{ id: string; displayName: string; binary?: string | null }>,
  installed: Readonly<Record<string, { installed?: boolean } | undefined>>,
): ContainerImage {
  const clis = new Set<string>()
  const without = new Set<string>()
  const unknown: string[] = []
  for (const entry of entries) {
    if (!entry.binary) continue
    const found = installed[entry.id]
    if (!found) {
      unknown.push(entry.displayName)
      continue
    }
    if (!found.installed || IMAGE_BASE_COMMANDS.has(entry.binary)) continue
    const cli = containerAgentFor(entry.binary)
    if (cli) clis.add(cli)
    else without.add(entry.displayName)
  }
  if (unknown.length > 0)
    throw new Error(
      `Studio could not tell whether ${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} set up on this computer, so it cannot work out a container's image. Try again in a moment.`,
    )
  return imageFor([...clis], [...without])
}

const lines = (...each: string[]) => each.join('\n')

/**
 * The Dockerfile for these agents (`containerAgentFor` ids, any order).
 * `without` names agents set up in Studio that have no Linux build Studio can
 * install: left out, and said so.
 */
export function imageFor(clis: readonly string[], without: readonly string[] = []): ContainerImage {
  const wanted = new Set(clis)
  const installed = AGENTS.filter((agent) => wanted.has(agent.cli))
  const refused: ContainerImage['refused'] = [...new Set(without)]
    .sort()
    .map((name) => ({ cli: name, why: `${name} has no Linux build Studio can install, so a container cannot run it.` }))
  const dockerfile = lines(
    "# Studio's image for a container: written by Studio (container-image.ts), not edited.",
    `FROM ${BASE_IMAGE}`,
    '',
    '# git, the GitHub CLI (its archive checked against its published digest), and what agents reach for.',
    'RUN apt-get -o Acquire::Retries=3 update \\',
    ' && apt-get -o Acquire::Retries=3 install -y --no-install-recommends \\',
    '      ca-certificates git openssh-client procps less ripgrep curl \\',
    ' && rm -rf /var/lib/apt/lists/* \\',
    ' && arch="$(dpkg --print-architecture)" \\',
    ` && case "$arch" in amd64) sum=${GH.sha256.amd64} ;; arm64) sum=${GH.sha256.arm64} ;; *) echo "No GitHub CLI for $arch" >&2; exit 1 ;; esac \\`,
    ` && curl -fsSL -o /tmp/gh.tgz "https://github.com/cli/cli/releases/download/v${GH.version}/gh_${GH.version}_linux_$arch.tar.gz" \\`,
    ' && echo "$sum  /tmp/gh.tgz" | sha256sum -c - \\',
    ` && tar -xzf /tmp/gh.tgz -C /tmp && mv /tmp/gh_${GH.version}_linux_$arch/bin/gh /usr/local/bin/gh && rm -rf /tmp/gh*`,
    '',
    // One layer each, so a changed set rebuilds only from the first difference.
    ...installed.map((agent) =>
      'npm' in agent
        ? `RUN npm install -g "${agent.npm}@${agent.version}" && npm cache clean --force`
        : `RUN mkdir -p /opt/${agent.dir} && HOME=/opt/${agent.dir} bash -o pipefail -c '${agent.script}' </dev/null && ln -sf /opt/${agent.dir}/${agent.linkFrom} /usr/local/bin/${agent.binary} && chmod -R a+rX /opt/${agent.dir}`,
    ),
    '',
    '# The CLIs are pinned here: they do not update themselves inside a container that is kept.',
    'ENV DISABLE_AUTOUPDATER=1',
    '',
    "# Agents run as the image's own unprivileged user, which owns where the logins volume is",
    "# mounted (Docker gives a new volume this folder's owner); Studio fills it after each start.",
    `RUN mkdir -p ${LOGINS_ROOT} && chown node:node ${LOGINS_ROOT}`,
    'USER node',
    'WORKDIR /home/node',
    'RUN mkdir -p /home/node/work',
    '',
    "# The container idles; Studio's server is started in it over `docker exec`.",
    'CMD ["sleep", "infinity"]',
    '',
  )
  const digest = createHash('sha256').update(dockerfile).digest('hex').slice(0, 12)
  return {
    tag: `${IMAGE_REPOSITORY}:${digest}`,
    dockerfile,
    agents: installed.map((agent) => ({
      cli: agent.cli,
      name: agent.name,
      version: 'npm' in agent ? agent.version : 'the newest when the image was built',
    })),
    refused,
  }
}
