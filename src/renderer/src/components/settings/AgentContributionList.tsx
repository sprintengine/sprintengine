import React, { type JSX } from 'react'

import type { AgentContributionLine } from './extensionContributions'

// What an extension hands the person's agents and chats, one row each: its
// name, then what it runs, reaches or sends where. A local server's command
// line and environment are set in mono so every character the agents will run
// can be read before it is approved.

export function AgentContributionList({
  lines,
  label,
}: {
  lines: AgentContributionLine[]
  label: string
}): JSX.Element | null {
  if (lines.length === 0) return null
  return (
    <ul aria-label={label} className="space-y-1.5">
      {lines.map((line, index) => (
        <li
          key={`${line.kind}:${index}`}
          className="rounded-sm bg-[color:var(--bg-well)] px-2 py-1.5 text-meta text-[color:var(--text-default)]"
        >
          <div className="text-[color:var(--text-strong)]">{line.title}</div>
          {line.details.map((detail) => (
            <div
              key={detail}
              className={
                line.kind === 'mcp-local'
                  ? 'font-mono text-micro text-[color:var(--text-muted)] [overflow-wrap:anywhere]'
                  : 'text-[color:var(--text-muted)] [overflow-wrap:anywhere]'
              }
            >
              {detail}
            </div>
          ))}
        </li>
      ))}
    </ul>
  )
}
