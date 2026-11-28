import { STUDIO_WORKSPACES_CAPABILITY } from '../../packages/studio-protocol/src/handshake'
import type { StudioClient } from '../../packages/client-runtime/src/public'

// The `discover` row: what a client reads of a machine before it starts a
// chat there, asked of the Studio that runs on it: the CLIs it runs
// (`cliRuntimes.list`), a project's checkout (`workspaces.checkout`) and what
// a chat in it can use (`workspaces.extensions`). It advertises
// `workspaces`, so it answers each, from its own machine. An agent running
// on that machine asks the same of its own Studio's gateway
// (`cli.runtime.list`, `workspace.checkout`, `workspace.extensions`) and hears
// the same machine's answer.

/** The CLI the reads name: one every Studio carries the manifest of. */
const CLI = 'claude-code'

export async function discoveredThere(
  who: string,
  client: StudioClient,
  workspaceId: string,
  expect: { git: boolean },
): Promise<void> {
  if (!client.supports(STUDIO_WORKSPACES_CAPABILITY))
    throw new Error(`${who}: the Studio does not serve ${STUDIO_WORKSPACES_CAPABILITY}`)
  const { clis } = await client.request('cliRuntimes.list', {})
  if (!clis.some((row) => row.id === CLI))
    throw new Error(`${who}: cliRuntimes.list does not name ${CLI} (${clis.map((row) => row.id).join(', ')})`)
  const checkout = await client.request('workspaces.checkout', { workspaceId })
  if (checkout.workspaceId !== workspaceId || checkout.git !== expect.git)
    throw new Error(`${who}: workspaces.checkout read ${JSON.stringify(checkout)}`)
  if (expect.git) {
    const current = checkout.branches?.find((branch) => branch.current)
    if (!checkout.branch || current?.name !== checkout.branch)
      throw new Error(`${who}: the checkout names no branch it is on (${JSON.stringify(checkout)})`)
  }
  const extensions = await client.request('workspaces.extensions', { workspaceId, cli: CLI })
  if (extensions.workspaceId !== workspaceId || !Array.isArray(extensions.skills) || !Array.isArray(extensions.servers))
    throw new Error(`${who}: workspaces.extensions read ${JSON.stringify(extensions)}`)
}

/** One tool call on an agent's own MCP connection to the machine's gateway: the JSON-RPC answer. */
export type AgentToolCall = (name: string, args: Record<string, unknown>) => Promise<Record<string, any> | null>

/** The tool's structured answer, or the reason it gave none. */
async function answered(who: string, call: AgentToolCall, name: string, args: Record<string, unknown>) {
  const reply = await call(name, args)
  const result = reply?.result as { isError?: boolean; structuredContent?: Record<string, any> } | undefined
  if (!result || result.isError || !result.structuredContent)
    throw new Error(`${who}: an agent there asked ${name} and got ${JSON.stringify(reply).slice(0, 300)}`)
  return result.structuredContent
}

export async function agentDiscoveredThere(
  who: string,
  call: AgentToolCall,
  workspaceId: string,
  expect: { git: boolean },
): Promise<void> {
  const { clis } = (await answered(who, call, 'cli.runtime.list', {})) as { clis: Array<{ id: string }> }
  if (!clis.some((row) => row.id === CLI))
    throw new Error(
      `${who}: an agent's cli.runtime.list does not name ${CLI} (${clis.map((row) => row.id).join(', ')})`,
    )
  const checkout = await answered(who, call, 'workspace.checkout', { workspaceId })
  if (checkout.workspaceId !== workspaceId || checkout.git !== expect.git)
    throw new Error(`${who}: an agent's workspace.checkout read ${JSON.stringify(checkout)}`)
  const extensions = await answered(who, call, 'workspace.extensions', { workspaceId, cli: CLI })
  if (extensions.workspaceId !== workspaceId || !Array.isArray(extensions.skills))
    throw new Error(`${who}: an agent's workspace.extensions read ${JSON.stringify(extensions)}`)
}
