import React, { useEffect } from 'react'

import type { ChatPanelFacts } from '../../../panels/agentChat/chatPanelStore'
import { CreatePullRequestDialogHost, useCreatePullRequestFlow } from '../../../panels/agentChat/createPullRequest'
import type { PullRequestHost } from '../../../panels/agentChat/pullRequestHost'
import type { PullRequestForge } from '../../../../../../shared/git/pr-url'
import { PermissionsRow, PullRequestRow, ServerRow } from './ChatPanelFactRows'

// For tests: the panel's control rows, drawn from the facts a chat publishes,
// with the Create PR flow the chat view holds in real life held here instead.

const NO_PULL_REQUESTS: ChatPanelFacts['pullRequests'] = []

export const panelFacts = (patch: Partial<ChatPanelFacts> = {}): ChatPanelFacts => ({
  name: 'Calendar screen rebuild',
  cli: 'claude-code',
  harnessLabel: 'Claude Code',
  modelLabel: 'Opus 5.5',
  machine: null,
  remote: false,
  branch: null,
  changes: null,
  pullRequests: NO_PULL_REQUESTS,
  createPullRequest: null,
  localServers: null,
  permissions: null,
  permissionLabel: null,
  ...patch,
})

type CreateProp = {
  host: PullRequestHost
  onSettled: () => void
  onHoldChange?: (held: boolean) => void
  ready?: boolean
  forge?: PullRequestForge | null
}

export function PanelFactRows({
  createPullRequest = null,
  now,
  ...patch
}: Partial<Omit<ChatPanelFacts, 'createPullRequest'>> & { createPullRequest?: CreateProp | null; now?: number }) {
  const forge = createPullRequest?.forge ?? null
  const flow = useCreatePullRequestFlow(
    createPullRequest?.host ?? null,
    forge,
    createPullRequest?.onSettled ?? NO_SETTLE,
  )
  const held = flow?.held ?? false
  const onHoldChange = createPullRequest?.onHoldChange
  useEffect(() => {
    onHoldChange?.(held)
  }, [held, onHoldChange])
  useEffect(() => () => onHoldChange?.(false), [onHoldChange])
  const facts = panelFacts({
    ...patch,
    createPullRequest: flow ? { flow, ready: createPullRequest?.ready ?? true, forge } : null,
  })
  return (
    <>
      <PullRequestRow facts={facts} {...(now !== undefined ? { now: () => now } : {})} />
      {facts.localServers ? <ServerRow localServers={facts.localServers} /> : null}
      <PermissionsRow facts={facts} />
      <CreatePullRequestDialogHost flow={flow} forge={forge} />
    </>
  )
}

const NO_SETTLE = (): void => undefined
