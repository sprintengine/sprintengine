import type { MeshConversationChange } from '../../../shared/tailnet-mesh'
import type { Workspace } from '../../../shared/workspace'
import type { WorkspaceLifecycleIntent } from '../../../shared/workspace-lifecycle'
import { environmentTargetOf } from '../components/panels/agentChat/environmentChat'
import { changeEnvironmentChat, settleEnvironmentChat } from '../studio/environmentChatRecords'
import {
  environmentRouteAvailable,
  WINDOW_STUDIO_ROUTE,
  type EnvironmentTarget,
} from '../studio/environmentStudio'

// A chat of this computer is changed as any other environment's chat is: by
// its Studio's `conversation.*` methods, over the window's own client
// (`environmentStudio.ts`'s `local` route). Its rest (Settle, Snooze), its
// marks (Star, colour, Auto-settle) and its name are the chat's record there;
// what the window draws of them comes back on the rows its own Studio lists
// (`environmentChats.ts`) and on the registry the window mirrors.
//
// A record the window still keeps of an SSH machine's or WSL distribution's
// chat (a copy, until copies go) is that machine's chat: asked there, by its
// route, as its row's menu asks it.

/** The window's own Studio, as its chats' changes are asked of it. */
const WINDOW_STUDIO: EnvironmentTarget = { route: WINDOW_STUDIO_ROUTE, name: 'This computer' }

/** What the window's own Studio said to a change: done, or why not. `unavailable` is a page with no Studio to ask. */
export type LocalChatAnswer = { ok: true } | { ok: false; code: string; message: string }

const NO_STUDIO: LocalChatAnswer = { ok: false, code: 'unavailable', message: 'This window has no Studio to ask.' }

/** Where a chat the window keeps a record of is changed: its machine's Studio for a copy, else the window's own. */
function studioOf(record: Pick<Workspace, 'environment'>): EnvironmentTarget {
  return environmentTargetOf(record.environment) ?? WINDOW_STUDIO
}

const refusalOf = (error: unknown): LocalChatAnswer => ({
  ok: false,
  code: 'unreachable',
  message: error instanceof Error ? error.message : String(error),
})

/** Ask a change to a chat the window keeps a record of, of its Studio: a mark, a name, or a snooze. */
export async function changeLocalChat(
  record: Pick<Workspace, 'id' | 'environment'>,
  change: MeshConversationChange,
): Promise<LocalChatAnswer> {
  const studio = studioOf(record)
  if (!environmentRouteAvailable(studio.route)) return NO_STUDIO
  try {
    const answer = await changeEnvironmentChat(studio, record.id, change)
    return answer.ok ? { ok: true } : { ok: false, code: answer.code, message: answer.message }
  } catch (error) {
    return refusalOf(error)
  }
}

/** Ask a gesture on a chat's rest of its Studio: Settle, Un-settle, Snooze or Wake. */
export async function restLocalChat(
  record: Pick<Workspace, 'id' | 'environment'>,
  intent: WorkspaceLifecycleIntent,
): Promise<LocalChatAnswer> {
  if (intent.kind === 'snooze') return changeLocalChat(record, { kind: 'snooze', until: intent.until })
  if (intent.kind === 'wake') return changeLocalChat(record, { kind: 'snooze', until: null })
  const studio = studioOf(record)
  if (!environmentRouteAvailable(studio.route)) return NO_STUDIO
  try {
    const answer = await settleEnvironmentChat(studio, record.id, intent.kind === 'settle')
    return answer.ok ? { ok: true } : { ok: false, code: answer.code, message: answer.message }
  } catch (error) {
    return refusalOf(error)
  }
}
