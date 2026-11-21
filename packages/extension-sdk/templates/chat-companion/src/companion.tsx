import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'

import type { ExtensionMount, ExtensionMountStudio, ModuleConversationSummary } from '@sprintengine/extension-sdk'

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

const text: CSSProperties = {
  fontFamily: 'var(--sem-font-family-ui)',
  fontSize: 'var(--sem-font-size-body)',
  color: 'var(--sem-color-text-default)',
}
const button: CSSProperties = {
  ...text,
  padding: 'var(--sem-space-xs) var(--sem-space-sm)',
  border: '1px solid var(--sem-color-border-default)',
  borderRadius: 'var(--sem-radius-control)',
  background: 'var(--sem-color-bg-surface-raised)',
  cursor: 'pointer',
}

// The panel, in a workspace's pane: it asks the worker for this extension's
// chats, starts a summary chat through the worker, and opens a chat draft
// itself. The worker pushes CHANGED_TOPIC whenever the list should be read
// again.
export function CompanionPanel({ studio }: { studio: ExtensionMountStudio }) {
  const workspaceId = studio.surface.workspaceId ?? studio.getActiveWorkspaceId()
  const [chats, setChats] = useState<ModuleConversationSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    const listed = await studio.methods<CompanionMethods>().read('list', {})
    if (listed.ok) setChats(listed.result)
    else setError(listed.message)
  }, [studio])

  useEffect(() => {
    void reload()
    return studio.subscribe(CHANGED_TOPIC, () => void reload())
  }, [reload, studio])
  useEffect(() => {
    if (chats !== null || error !== null) studio.ready()
  }, [chats, error, studio])

  const summarise = async () => {
    if (!workspaceId) return
    setBusy(true)
    setError(null)
    const result = await studio.methods<CompanionMethods>().operate('start', { workspaceId })
    setBusy(false)
    if (!result.ok) setError(result.message)
    else studio.focusTab({ workspaceId, kind: 'chat', id: result.result.conversation.agentId })
  }

  // openChat puts the prompt in a new chat's composer as a draft: the person
  // reads it and sends it (pass `send: true` to send it for them).
  const draft = async () => {
    if (!workspaceId) return
    const opened = await studio.openChat({ workspaceId, prompt: 'Help me plan the next change to this project.' })
    if (!opened.ok) setError(opened.message)
  }

  return (
    <div
      style={{
        ...text,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--sem-space-md)',
        padding: 'var(--sem-space-md)',
      }}
    >
      <div style={{ display: 'flex', gap: 'var(--sem-space-sm)' }}>
        <button type="button" style={button} disabled={!workspaceId || busy} onClick={() => void summarise()}>
          {busy ? 'Starting…' : 'Summarise this project'}
        </button>
        <button type="button" style={button} disabled={!workspaceId} onClick={() => void draft()}>
          Open a chat draft
        </button>
      </div>
      {error ? <p style={{ margin: 0, color: 'var(--sem-color-status-danger)' }}>{error}</p> : null}
      <h3 style={{ margin: 0, fontSize: 'var(--sem-font-size-meta)', color: 'var(--sem-color-text-muted)' }}>
        Chats this extension started
      </h3>
      {chats === null ? null : chats.length === 0 ? (
        <p style={{ margin: 0, color: 'var(--sem-color-text-muted)' }}>None yet. Summarise the project to start one.</p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
          {chats.map((chat) => (
            <li key={chat.agentId}>
              <button
                type="button"
                style={{ ...button, border: 'none', background: 'transparent', width: '100%', textAlign: 'left' }}
                onClick={() => studio.focusTab({ workspaceId: chat.workspaceId, kind: 'chat', id: chat.agentId })}
              >
                {chat.name} · {STATUS_WORDS[chat.status]}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export const mount: ExtensionMount = (root, studio) => {
  const view = createRoot(root)
  view.render(<CompanionPanel studio={studio} />)
  return () => view.unmount()
}
