import { STUDIO_CHAT_ROWS_CAPABILITY } from '../../packages/studio-protocol/src/handshake'
import { answered, type DesktopAgent } from './agent-by-address'
import type { StudioClient } from '../../packages/client-runtime/src/public'
import type { StudioWorkspace } from '../../packages/studio-protocol/src/workspaces'

// The `list` row: a chat is listed by the Studio it runs on, at its address
// (that Studio's environment id and the chat's id), with what a sidebar row
// draws (`chat-rows`), and a mark or a settle asked by one client reads back
// in every client's list. Each client reaches the chat's Studio its own way.

/** One client's way to ask the Studio the chat runs on. */
export type ListReach = { who: string; ask<T>(work: (client: StudioClient) => Promise<T>): Promise<T> }

type Listed = { address: string; row: StudioWorkspace | undefined }

async function listedBy(reach: ListReach, chatId: string): Promise<Listed> {
  return reach.ask(async (client) => {
    const capabilities = client.welcome.capabilities as readonly string[]
    if (!capabilities.includes(STUDIO_CHAT_ROWS_CAPABILITY))
      throw new Error(`${reach.who}: the Studio does not serve ${STUDIO_CHAT_ROWS_CAPABILITY}`)
    const { workspaces } = await client.request('workspaces.list', {})
    return {
      address: `${client.welcome.environment.id}:${chatId}`,
      row: workspaces.find((workspace) => workspace.id === chatId),
    }
  })
}

/** Every client's list, read until each says what `holds` wants, or 15 s. */
async function everyList(
  reaches: readonly ListReach[],
  chatId: string,
  holds: (row: StudioWorkspace) => boolean,
  what: string,
): Promise<void> {
  const deadline = Date.now() + 15_000
  for (const reach of reaches) {
    for (;;) {
      const { row } = await listedBy(reach, chatId)
      if (row && holds(row)) break
      if (Date.now() > deadline) throw new Error(`${reach.who}: its list never said ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

/** The chat is at one address in every client's list, with its row's facts. */
export async function listedAtItsAddress(reaches: readonly ListReach[], chatId: string): Promise<void> {
  const addresses = new Set<string>()
  for (const reach of reaches) {
    const { address, row } = await listedBy(reach, chatId)
    if (!row) throw new Error(`${reach.who}: the chat is not in its list`)
    if (typeof row.createdAt !== 'number' || typeof row.recencyAt !== 'number')
      throw new Error(`${reach.who}: its row carries no clocks (${JSON.stringify(row)})`)
    addresses.add(address)
  }
  if (addresses.size !== 1) throw new Error(`the chat is at more than one address: ${[...addresses].join(', ')}`)
}

/** A star asked by `from` reads back in every client's list. */
export async function markReadsBack(from: ListReach, reaches: readonly ListReach[], chatId: string): Promise<void> {
  await from.ask((client) =>
    client.request('conversation.highlight', {
      workspaceId: chatId,
      commandId: `list-star-${from.who}`,
      starred: true,
    }),
  )
  await everyList(reaches, chatId, (row) => row.highlight?.starred === true, 'it is starred')
}

/** A settle asked by `from` reads back in every client's list. */
export async function settleReadsBack(from: ListReach, reaches: readonly ListReach[], chatId: string): Promise<void> {
  await from.ask((client) =>
    client.request('conversation.settle', { workspaceId: chatId, commandId: `list-settle-${from.who}` }),
  )
  await everyList(reaches, chatId, (row) => typeof row.settledAt === 'number', 'it is settled')
}

/**
 * A star taken off and a settle undone by an agent on the desktop, naming the
 * chat by its address, read back in every list: the machine's own record moved.
 */
export async function agentTidyReadsBack(
  agent: DesktopAgent,
  reaches: readonly ListReach[],
  chatId: string,
): Promise<void> {
  const chat = agent.addressOf(chatId)
  answered(agent.who, 'unstar', await agent.call('conversation.highlight', { chat, starred: false }))
  await everyList(reaches, chatId, (row) => row.highlight?.starred !== true, 'its star is off')
  answered(agent.who, 'un-settle', await agent.call('conversation.settle', { chat, settled: false }))
  await everyList(reaches, chatId, (row) => row.settledAt == null, 'it is back from settled')
}
