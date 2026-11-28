import { chatLinkFor, parseChatLink } from '../../packages/studio-protocol/src/chat-link'
import type { ListReach } from './list'

// The `open` row: a chat is opened by its link. The client is handed the
// link a menu's Copy link writes (`chatLinkFor`, the environment id of the
// Studio the chat runs on and the chat's id), reads it with the one grammar
// every client reads links by (`parseChatLink`), finds the Studio it reaches
// whose environment id the link names, finds the chat in that Studio's list
// and reads its transcript. A link naming an environment the client reaches
// no Studio of opens nothing.

/** The link to a chat on the Studio `holder` reaches, as Copy link writes it. */
export async function linkTo(holder: ListReach, chatId: string, agentId?: string): Promise<string> {
  const environmentId = await holder.ask(async (client) => client.welcome.environment.id)
  const link = chatLinkFor({ environmentId, chatId }, agentId ?? null)
  if (!link) throw new Error(`${holder.who}: no link can carry ${environmentId}:${chatId}`)
  return link
}

/** The Studio among `studios` whose environment id is `environmentId`, or null. */
async function studioOf(studios: readonly ListReach[], environmentId: string): Promise<ListReach | null> {
  for (const studio of studios)
    if ((await studio.ask(async (client) => client.welcome.environment.id)) === environmentId) return studio
  return null
}

/** `who` opens the chat `link` names among the Studios it reaches, and reads what was said in it. */
export async function openedByLink(who: string, studios: readonly ListReach[], link: string): Promise<void> {
  const parsed = parseChatLink(link)
  if (!parsed?.environmentId) throw new Error(`${who}: ${link} is not a chat link with an environment`)
  const studio = await studioOf(studios, parsed.environmentId)
  if (!studio) throw new Error(`${who}: no Studio it reaches is environment ${parsed.environmentId}`)
  await studio.ask(async (client) => {
    const { workspaces } = await client.request('workspaces.list', {})
    const row = workspaces.find((workspace) => workspace.id === parsed.chatId)
    if (!row) throw new Error(`${who}: ${parsed.chatId} is not in the list of the Studio the link names`)
    const agentId = parsed.agentId ?? row.agentIds?.[0]
    if (!agentId) throw new Error(`${who}: the chat has no agent to open`)
    // Named by the chat and its agent, as a link names it: the Studio finds its folder.
    const read = await client.conversations.loadEarlier({ workspaceId: row.id, agentId }, Number.MAX_SAFE_INTEGER, 20)
    if (!read.ok) throw new Error(`${who}: the chat did not open: ${read.message}`)
    if (read.page.events.length === 0) throw new Error(`${who}: the chat opened with nothing in it`)
  })
  // A link to an environment it reaches no Studio of is not opened anywhere.
  const elsewhere = `sprintengine://chat/env-nowhere/${parsed.chatId}`
  if (await studioOf(studios, parseChatLink(elsewhere)!.environmentId!))
    throw new Error(`${who}: a link to an environment it does not reach opened a chat`)
}
