import { STUDIO_WORKSPACES_CAPABILITY } from '../../packages/studio-protocol/src/handshake'
import type { StudioClient } from '../../packages/client-runtime/src/public'

// The `discover` row: what a client reads of a machine before it starts a
// chat there, asked of the Studio that runs on it: the CLIs it runs
// (`cliRuntimes.list`), a project's checkout (`workspaces.checkout`) and what
// a chat in it can use (`workspaces.extensions`). It advertises
// `workspaces`, so it answers each, from its own machine.

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
