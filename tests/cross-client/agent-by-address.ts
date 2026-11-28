import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { StudioClient } from '../../packages/client-runtime/src/public'
import type { McpConnectionContext, McpToolResult } from '../../src/shared/modules/mcp-tools'
import { createNodeStudioPlatform, resetStudioPlatform } from '../../src/server/platform/platform'
import { createStudioCore, type StudioCore } from '../../src/server/core/studio-core'
import { createStudioGateway } from '../../src/server/core/studio-gateway'

// An agent on the desktop naming a chat on an SSH machine or a WSL
// distribution by its address: the desktop's gateway, as a headless core
// builds it, reaching that machine's Studio on the same client the window
// reaches it by, and routing the machine's environment id there as the
// shell's environment registry does. Its `conversation.create` and its
// lifecycle tools are carried out by the machine's Studio, on the machine's
// own record of the chat.

const CALLER: McpConnectionContext = { metadata: { kind: 'external-local' } }

export type DesktopAgent = {
  /** The machine, as its refusals name it. */
  who: string
  /** The chat's address on the machine. */
  addressOf(chatId: string): string
  environmentId: string
  call(tool: string, args: Record<string, unknown>): Promise<McpToolResult>
  close(): Promise<void>
}

export async function desktopAgentReaching(input: {
  who: string
  route: string
  client: () => Promise<StudioClient>
}): Promise<DesktopAgent> {
  const environmentId = (await input.client()).welcome.environment.id
  const dataDir = await mkdtemp(join(tmpdir(), `gate-desktop-agent-${input.who}-`))
  const clients: NonNullable<StudioCore['environmentClients']> = {
    clientFor: async (route) =>
      route === input.route
        ? { ok: true, client: await input.client(), name: input.who }
        : { ok: false, code: 'unavailable', message: `${route} is not reached in the gate.` },
    onConnected: () => () => undefined,
    // The window's client already spells the machine's paths for this computer.
    spellingOf: () => null,
  }
  const core = createStudioCore(createNodeStudioPlatform({ dataDir, packaged: false, version: '0.0.0-gate' }), {
    role: 'server',
  })
  // The desktop's clients of its machines, as its core combines them: a WSL
  // distribution's are its own supervisor's on Windows, which the gate wires
  // itself (main.ts says so), so the gateway is handed the window's client of
  // either machine.
  const gateway = createStudioGateway(
    { ...core, environmentClients: clients },
    {
      environmentRoutes: async (id) => (id === environmentId ? [input.route] : []),
    },
  )
  return {
    who: input.who,
    environmentId,
    addressOf: (chatId) => `${environmentId}:${chatId}`,
    call: async (tool, args) => {
      const registered = gateway.ownTools().find((each) => each.name === tool)
      if (!registered) throw new Error(`${input.who}: the desktop's gateway has no ${tool}`)
      return (await registered.handler(args, CALLER)) as McpToolResult
    },
    close: async () => {
      await gateway.shutdown()
      await core.shutdown()
      resetStudioPlatform()
      await rm(dataDir, { recursive: true, force: true })
    },
  }
}

/** A tool's answer, or its refusal thrown in its words. */
export function answered(who: string, what: string, result: McpToolResult): Record<string, unknown> {
  const body = (result.structuredContent ?? {}) as Record<string, unknown>
  if (result.isError) throw new Error(`${who}: the agent's ${what} was refused: ${JSON.stringify(body)}`)
  return body
}

/**
 * The agent starts a chat in the machine's project by the machine's
 * environment id, as `conversation.create` with `environment`. The fake
 * provider has no CLI (gaps.ts, `peer:create`), so the machine's own Studio
 * refuses it, in its words: proof the create was carried out there.
 */
export async function agentCreatesThere(agent: DesktopAgent, workspaceId: string): Promise<void> {
  const result = await agent.call('conversation.create', {
    environment: agent.environmentId,
    workspaceId,
    newChat: true,
    cli: 'mock-provider',
    prompt: 'started by an agent on the desktop',
    notifyParent: false,
  })
  const body = (result.structuredContent ?? {}) as { error?: { message?: string } }
  if (result.isError) {
    const message = body.error?.message ?? ''
    if (!message.startsWith(`${agent.who}: `) || !/run as a chat/u.test(message))
      throw new Error(`${agent.who}: the agent's create was not carried out on the machine: ${JSON.stringify(body)}`)
  }
  await agentCreatesInPlanThere(agent, workspaceId)
}

/**
 * The agent starts a plan chat there: the mode goes with the create, and the
 * machine's own launch judges it, as a create on that machine does. No CLI
 * starts a chat in the gate (gaps.ts, `peer:create`), so it is asked of Codex,
 * whose chat cannot plan: the machine refuses it `unsupported_mode` in its
 * words. A desktop that dropped the mode would see the machine start it
 * writable instead; one that refused it itself would not name the machine.
 */
async function agentCreatesInPlanThere(agent: DesktopAgent, workspaceId: string): Promise<void> {
  const result = await agent.call('conversation.create', {
    environment: agent.environmentId,
    workspaceId,
    newChat: true,
    cli: 'codex',
    mode: 'plan',
    prompt: 'planned by an agent on the desktop',
    notifyParent: false,
  })
  const error = ((result.structuredContent ?? {}) as { error?: { code?: string; message?: string } }).error
  if (!result.isError || error?.code !== 'unsupported_mode' || !error.message?.startsWith(`${agent.who}: `))
    throw new Error(
      `${agent.who}: the agent's plan create was not judged by the machine in its mode: ${JSON.stringify(result.structuredContent)}`,
    )
}
