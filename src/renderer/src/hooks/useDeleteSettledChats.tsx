import React, { useCallback, useState } from 'react'
import { changeEnvironmentChat, environmentChatDeletePlan } from '../studio/environmentChatRecords'
import type { EnvironmentTarget } from '../studio/environmentStudio'
import type {
  SettledChatDeletionOutcome,
  SettledChatDeletionPlan,
} from '../../../../packages/studio-protocol/src/public'

import { showToast } from '../store/toastStore'
import { useConfirmDialog } from '../components/ui/ConfirmDialog'
import type { SettledChatEntry } from '../components/settings/settledChatsModel'
import { deletionConfirmation, deletionToast } from '../utils/settledChatDeletion'
import { worktreesApi } from '../studio/worktrees'
import { copy as appCopy } from '../../../shared/copy'

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A settled chat to delete: this computer's, or another environment's, where it is. */
export type SettledChatToDelete = Pick<SettledChatEntry, 'key' | 'chatId' | 'title' | 'environment'>

/** One chat's plan, keyed by its entry: what deleting it would do, as the Studio that holds it says. */
type Planned = { chat: SettledChatToDelete; plan: SettledChatDeletionPlan; gone: boolean }

const targetOf = (chat: SettledChatToDelete): EnvironmentTarget | null =>
  chat.environment ? { route: chat.environment.route, name: chat.environment.machineName } : null

/** What deleting this computer's chats would do, as its own Studio plans it. */
async function planHere(chats: readonly SettledChatToDelete[]): Promise<Planned[]> {
  if (chats.length === 0) return []
  const plans = await worktreesApi.planSettledChatDeletion(chats.map((chat) => chat.chatId))
  const byId = new Map(plans.map((plan) => [plan.workspaceId, plan]))
  return chats.map((chat) => ({
    chat,
    plan: { ...(byId.get(chat.chatId) ?? missingPlan(chat.chatId)), workspaceId: chat.key },
    gone: false,
  }))
}

const missingPlan = (workspaceId: string): SettledChatDeletionPlan => ({
  workspaceId,
  remoteMachine: null,
  worktrees: [],
  refused: 'This chat is not here any more.',
})

/** What deleting another environment's chat would do, as that environment plans it; one away refuses in words. */
async function planThere(chat: SettledChatToDelete, target: EnvironmentTarget): Promise<Planned> {
  const refused = (message: string): Planned => ({
    chat,
    plan: { workspaceId: chat.key, remoteMachine: null, worktrees: [], refused: message },
    gone: false,
  })
  try {
    const plan = await environmentChatDeletePlan(target, chat.chatId)
    if (!plan.ok) return refused(plan.message)
    return {
      chat,
      plan: {
        workspaceId: chat.key,
        remoteMachine: null,
        // A worktree there is named, never pathed: its path is that machine's.
        worktrees: plan.worktrees.map((tree) => ({ ...tree, path: tree.name })),
        ...(plan.refused ? { refused: plan.refused } : {}),
      },
      gone: plan.gone === true,
    }
  } catch (error) {
    return refused(errorText(error))
  }
}

/** Delete this computer's chats on its own Studio; outcomes keyed by entry. */
async function deleteHere(chats: readonly SettledChatToDelete[]): Promise<SettledChatDeletionOutcome[]> {
  if (chats.length === 0) return []
  const keyOf = new Map(chats.map((chat) => [chat.chatId, chat.key]))
  const outcomes = await worktreesApi.deleteSettledChats(chats.map((chat) => chat.chatId))
  return outcomes.map((outcome) => ({ ...outcome, workspaceId: keyOf.get(outcome.workspaceId) ?? outcome.workspaceId }))
}

/** Delete another environment's chat there, for every device that follows it; one away fails in words. */
async function deleteThere(
  chat: SettledChatToDelete,
  target: EnvironmentTarget,
  gone: boolean,
): Promise<SettledChatDeletionOutcome> {
  // Gone there already: there is nothing left to delete.
  if (gone) return { workspaceId: chat.key, ok: true, worktrees: [] }
  try {
    const deleted = await changeEnvironmentChat(target, chat.chatId, { kind: 'delete' })
    return deleted.ok
      ? { workspaceId: chat.key, ok: true, worktrees: [] }
      : { workspaceId: chat.key, ok: false, message: deleted.message }
  } catch (error) {
    return { workspaceId: chat.key, ok: false, message: errorText(error) }
  }
}

/** The line that says where chats on other machines are deleted, when any are. */
function whereSentence(chats: readonly SettledChatToDelete[]): string[] {
  const machines = [...new Set(chats.flatMap((chat) => (chat.environment ? [chat.environment.machineName] : [])))]
  if (machines.length === 0) return []
  if (chats.length === 1) return [`It runs on ${machines[0]}, and is deleted there, for every device that follows it.`]
  return [`Chats on another machine are deleted there, for every device that follows them: ${machines.join(', ')}.`]
}

/**
 * Delete settled chats, one or many, wherever each is: the Studio that holds
 * each (this computer's own, or another environment's) says what would go
 * (`settledChats.planDelete` here, `conversation.deletePlan` there), the
 * app's confirm dialog says it to the person once for all of them, and only
 * then does each Studio delete, checking everything again. This computer's
 * records leave the store on main's broadcast; another environment's chats
 * leave its list when its source next reads (`onDeletedThere`). Resolves
 * with the keys of the chats that were deleted.
 */
export function useDeleteSettledChats(
  options: {
    /** Another environment's chats went: read its list again. */
    onDeletedThere?: (route: string) => void
  } = {},
): {
  deleteChats: (chats: readonly SettledChatToDelete[]) => Promise<string[]>
  /** The keys of the chats being deleted now. */
  deleting: ReadonlySet<string>
} {
  const dialog = useConfirmDialog()
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set())
  const { onDeletedThere } = options

  const deleteChats = useCallback(
    async (chats: readonly SettledChatToDelete[]): Promise<string[]> => {
      if (chats.length === 0) return []
      const failed = (description: string) =>
        showToast({
          tone: 'error',
          title:
            chats.length === 1
              ? appCopy.hooks.useDeleteSettledChats.theChatWasNotDeleted
              : appCopy.hooks.useDeleteSettledChats.theChatsWereNotDeleted,
          description,
        })
      const titles = new Map(chats.map((chat) => [chat.key, chat.title]))
      const titleOf = (key: string) => titles.get(key) ?? 'this chat'
      let planned: Planned[]
      try {
        planned = (
          await Promise.all([
            planHere(chats.filter((chat) => !chat.environment)),
            ...chats.flatMap((chat) => {
              const target = targetOf(chat)
              return target ? [planThere(chat, target).then((each) => [each])] : []
            }),
          ])
        ).flat()
      } catch (error) {
        failed(errorText(error))
        return []
      }
      const deletable = planned.filter((each) => !each.plan.refused)
      if (deletable.length === 0) {
        failed(planned.find((each) => each.plan.refused)?.plan.refused ?? 'Nothing could be deleted.')
        return []
      }
      const confirmation = deletionConfirmation(
        deletable.map((each) => each.plan),
        titleOf,
        planned.length - deletable.length,
      )
      const confirmed = await dialog.confirm({
        title: confirmation.title,
        body: (
          <div className="space-y-2">
            {[...whereSentence(deletable.map((each) => each.chat)), ...confirmation.paragraphs].map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
        ),
        confirmLabel: confirmation.confirmLabel,
        tone: 'danger',
      })
      if (!confirmed) return []
      const keys = deletable.map((each) => each.chat.key)
      setDeleting((current) => new Set([...current, ...keys]))
      try {
        const outcomes = (
          await Promise.all([
            deleteHere(deletable.filter((each) => !each.chat.environment).map((each) => each.chat)),
            ...deletable.flatMap((each) => {
              const target = targetOf(each.chat)
              return target ? [deleteThere(each.chat, target, each.gone).then((outcome) => [outcome])] : []
            }),
          ])
        ).flat()
        showToast(deletionToast(outcomes, titleOf))
        const gone = new Set(outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.workspaceId))
        for (const route of new Set(
          deletable.flatMap((each) =>
            each.chat.environment && gone.has(each.chat.key) ? [each.chat.environment.route] : [],
          ),
        ))
          onDeletedThere?.(route)
        return [...gone]
      } catch (error) {
        failed(errorText(error))
        return []
      } finally {
        setDeleting((current) => new Set([...current].filter((key) => !keys.includes(key))))
      }
    },
    [dialog, onDeletedThere],
  )

  return { deleteChats, deleting }
}
