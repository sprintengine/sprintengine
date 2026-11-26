import { showToast, useToastStore } from '../../store/toastStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { copy as appCopy } from '../../../../shared/copy'

// Opening a chat New chat started on another machine whose chats this desktop
// lists from its copy of that machine's records (an SSH machine, a WSL
// distribution): the record arrives when the copy next reads the machine,
// which is usually at once and sometimes later. New chat waits a moment for
// it; after that the chat is still opened the moment it is listed, while its
// toast is up, and the toast says so and offers to open it. A chat that is
// never listed is said, with Open to try again: never a silent success.

/** How long New chat stays up waiting for the record. */
export const ENVIRONMENT_RECORD_WAIT_MS = 10_000
/** How long after that the chat is still opened when its record arrives, before the toast says it has not. */
export const ENVIRONMENT_RECORD_LATE_MS = 5 * 60_000

/** Whether a workspace record is in the store, once it is or when the time runs out. */
export function waitForWorkspaceRecord(workspaceId: string, withinMs: number): Promise<boolean> {
  const has = () => useWorkspaceStore.getState().workspaces.some((workspace) => workspace.id === workspaceId)
  if (has()) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      stop()
      resolve(false)
    }, withinMs)
    const stop = useWorkspaceStore.subscribe(() => {
      if (!has()) return
      clearTimeout(timer)
      stop()
      resolve(true)
    })
  })
}

export async function openEnvironmentChatWhenListed(input: {
  chatId: string
  toastId: string
  title: string
  machineName: string
  /** Opens the chat in this window; false while it is not listed here. */
  openHere: () => boolean
  closePanel: () => void
  /** The toast for a chat that opened. */
  started: () => void
}): Promise<void> {
  const { chatId, toastId, title, machineName, openHere } = input
  const arrived = await waitForWorkspaceRecord(chatId, ENVIRONMENT_RECORD_WAIT_MS)
  input.closePanel()
  if (arrived && openHere()) {
    input.started()
    return
  }
  const dismiss = () => useToastStore.getState().dismissToast(toastId)
  const shown = () => useToastStore.getState().toasts.some((toast) => toast.id === toastId)
  const openAction = {
    id: 'open',
    label: appCopy.workspace.workspaceManager.openTheChat,
    primary: true,
    run: () => {
      if (openHere()) dismiss()
    },
  }
  showToast({
    id: toastId,
    tone: 'neutral',
    title: appCopy.workspace.workspaceManager.chatStartedOn(machineName),
    description: appCopy.workspace.workspaceManager.itOpensHereOnceListed(title, machineName),
    actions: [openAction],
    autoDismissMs: false,
  })
  const later = await waitForWorkspaceRecord(chatId, ENVIRONMENT_RECORD_LATE_MS)
  // Dismissed meanwhile: the person moved on, and the chat waits in the sidebar.
  if (!shown()) return
  if (later) {
    if (openHere()) dismiss()
    return
  }
  showToast({
    id: toastId,
    tone: 'warn',
    title: appCopy.workspace.workspaceManager.chatNotListedHere(machineName),
    description: appCopy.workspace.workspaceManager.itRunsThereNotListed(title, machineName),
    actions: [openAction],
    autoDismissMs: false,
  })
}
