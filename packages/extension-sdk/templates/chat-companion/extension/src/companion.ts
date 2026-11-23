import type { ExtensionMount, ModuleConversationSummary } from '@sprintengine/extension-sdk'

import { CHANGED_TOPIC, type CompanionMethods } from './protocol'

const STATUS_WORDS: Record<ModuleConversationSummary['status'], string> = {
  starting: 'Starting',
  ready: 'Waiting for you',
  active: 'Working',
  awaiting_approval: 'Needs your approval',
  stopped: 'Stopped',
  failed: 'Failed',
  absent: 'Not running',
}

/** A chat's row: its name and, in words, how it is doing. */
export function chatLabel(chat: ModuleConversationSummary): string {
  return `${chat.name} · ${STATUS_WORDS[chat.status]}`
}

// The panel, in a workspace's pane and a frame of its own: it asks the worker
// for this extension's chats, starts a summary chat through the worker, and
// opens a chat draft itself. The worker pushes CHANGED_TOPIC whenever the
// list should be read again; the panel hears it as a `push`.
export const mount: ExtensionMount = async (root, studio) => {
  const document = root.ownerDocument
  const workspaceId = studio.surface.workspaceId ?? null
  const methods = studio.methods<CompanionMethods>()

  const view = document.createElement('div')
  view.style.cssText = 'display: flex; flex-direction: column; gap: 12px; padding: 12px'
  const actions = document.createElement('div')
  actions.style.cssText = 'display: flex; gap: 8px'
  const error = document.createElement('p')
  error.style.cssText = 'margin: 0; color: var(--tone-error)'
  error.hidden = true
  const heading = document.createElement('h3')
  heading.className = 'se-muted'
  heading.style.cssText = 'margin: 0; font-size: 12px'
  heading.textContent = 'Chats this extension started'
  const list = document.createElement('div')
  view.append(actions, error, heading, list)
  root.append(view)

  const showError = (message: string | null) => {
    error.textContent = message ?? ''
    error.hidden = message === null
  }
  const button = (label: string, onClick: () => void) => {
    const element = document.createElement('button')
    element.type = 'button'
    element.className = 'se-button'
    element.textContent = label
    element.addEventListener('click', onClick)
    return element
  }
  const focusChat = (chat: { workspaceId: string; agentId: string }) =>
    void studio.host.call('tabs.focus', { workspaceId: chat.workspaceId, kind: 'chat', id: chat.agentId })

  const summarise = button('Summarise this project', async () => {
    if (!workspaceId) return
    summarise.disabled = true
    summarise.textContent = 'Starting…'
    showError(null)
    const result = await methods.operate('start', { workspaceId })
    summarise.disabled = false
    summarise.textContent = 'Summarise this project'
    if (!result.ok) showError(result.message)
    else focusChat(result.result.conversation)
  })
  // `chat.draft` puts the prompt in a new chat's composer as a draft: the
  // person reads it and sends it (permission `chat:draft`).
  const draft = button('Open a chat draft', async () => {
    if (!workspaceId) return
    const opened = await studio.host.call('chat.draft', {
      workspaceId,
      prompt: 'Help me plan the next change to this project.',
    })
    if (!opened.ok) showError(opened.message)
  })
  summarise.disabled = draft.disabled = !workspaceId
  actions.append(summarise, draft)

  const reload = async () => {
    const listed = await methods.read('list', {})
    if (!listed.ok) return showError(listed.message)
    if (listed.result.length === 0) {
      const none = document.createElement('p')
      none.className = 'se-muted'
      none.style.margin = '0'
      none.textContent = 'None yet. Summarise the project to start one.'
      return list.replaceChildren(none)
    }
    const rows = document.createElement('ul')
    rows.className = 'se-list'
    for (const chat of listed.result) {
      const row = document.createElement('li')
      row.className = 'se-list-row'
      const open = button(chatLabel(chat), () => focusChat(chat))
      open.style.cssText = 'border: none; background: transparent; width: 100%; justify-content: flex-start'
      row.append(open)
      rows.append(row)
    }
    list.replaceChildren(rows)
  }

  const heard = studio.on('push', (push) => {
    if (push.topic === CHANGED_TOPIC) void reload()
  })
  await reload()
  studio.ready()
  return () => {
    heard.dispose()
    view.remove()
  }
}
