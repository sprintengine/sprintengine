import {
  STUDIO_CHAT_REST_SEEN_CAPABILITY,
  STUDIO_CHAT_ROWS_CAPABILITY,
} from '../../packages/studio-protocol/src/handshake'
import type { StudioChatSeen } from '../../packages/studio-protocol/src/chat-lifecycle'
import { answered, type DesktopAgent } from './agent-by-address'
import type { StudioClient } from '../../packages/client-runtime/src/public'
import type { StudioWorkspace } from '../../packages/studio-protocol/src/workspaces'

// The `list` row: a chat is listed by the Studio it runs on, at its address
// (that Studio's environment id and the chat's id), with what a sidebar row
// draws (`chat-rows`), and a mark or a settle asked by one client reads back
// in every client's list. A settle asked on a row the chat has moved on from
// (`chat-rest-seen`) is refused, whoever asks. Each client reaches the chat's
// Studio its own way.

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

/** The chat as `from`'s list draws it now, which a settle from its row sends back. */
async function seenBy(from: ListReach, chatId: string): Promise<StudioChatSeen> {
  const { row } = await listedBy(from, chatId)
  const supported = await from.ask(async (client) =>
    (client.welcome.capabilities as readonly string[]).includes(STUDIO_CHAT_REST_SEEN_CAPABILITY),
  )
  if (!supported) throw new Error(`${from.who}: the Studio does not serve ${STUDIO_CHAT_REST_SEEN_CAPABILITY}`)
  if (!row || typeof row.activityAt !== 'number')
    throw new Error(`${from.who}: its row says no activityAt (${JSON.stringify(row)})`)
  return { settledAt: row.settledAt ?? null, snoozedUntil: row.snoozedUntil ?? null, activityAt: row.activityAt }
}

/**
 * A settle `from` asks on a reading older than the chat (activity it did not
 * see) is refused `conflict`, and the chat stays in every list.
 */
export async function staleSettleRefused(
  from: ListReach,
  reaches: readonly ListReach[],
  chatId: string,
): Promise<void> {
  const seen = await seenBy(from, chatId)
  const refused = await from.ask(async (client) => {
    try {
      await client.request('conversation.settle', {
        workspaceId: chatId,
        commandId: `list-stale-settle-${from.who}`,
        seen: { ...seen, activityAt: seen.activityAt - 1 },
      })
      return null
    } catch (error) {
      return error as { code?: string; message?: string }
    }
  })
  if (!refused) throw new Error(`${from.who}: a settle on a stale row was carried out`)
  if (refused.code !== 'conflict')
    throw new Error(`${from.who}: a stale settle was refused ${refused.code}, not conflict`)
  await everyList(reaches, chatId, (row) => row.settledAt == null, 'it is still in the list')
}

/** A settle asked by `from` on the row its list draws now reads back in every client's list. */
export async function settleReadsBack(from: ListReach, reaches: readonly ListReach[], chatId: string): Promise<void> {
  const seen = await seenBy(from, chatId)
  await from.ask((client) =>
    client.request('conversation.settle', { workspaceId: chatId, commandId: `list-settle-${from.who}`, seen }),
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
