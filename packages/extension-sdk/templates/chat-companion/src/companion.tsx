import { useCallback, useEffect, useState } from 'react'
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

// The panel, in a workspace's pane and a frame of its own: it asks the worker
// for this extension's chats, starts a summary chat through the worker, and
// opens a chat draft itself. The worker pushes CHANGED_TOPIC whenever the
// list should be read again; the panel hears it as a `push`.
export function CompanionPanel({ studio }: { studio: ExtensionMountStudio }) {
  const workspaceId = studio.surface.workspaceId ?? null
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
    const heard = studio.on('push', (push) => {
      if (push.topic === CHANGED_TOPIC) void reload()
    })
    return () => heard.dispose()
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
    else void studio.host.call('tabs.focus', { workspaceId, kind: 'chat', id: result.result.conversation.agentId })
  }

  // `chat.draft` puts the prompt in a new chat's composer as a draft: the
  // person reads it and sends it (permission `chat:draft`).
  const draft = async () => {
    if (!workspaceId) return
    const opened = await studio.host.call('chat.draft', {
      workspaceId,
      prompt: 'Help me plan the next change to this project.',
    })
    if (!opened.ok) setError(opened.message)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 12 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="se-button" disabled={!workspaceId || busy} onClick={() => void summarise()}>
          {busy ? 'Starting…' : 'Summarise this project'}
        </button>
        <button type="button" className="se-button" disabled={!workspaceId} onClick={() => void draft()}>
          Open a chat draft
        </button>
      </div>
      {error ? <p style={{ margin: 0, color: 'var(--tone-error)' }}>{error}</p> : null}
      <h3 className="se-muted" style={{ margin: 0, fontSize: 12 }}>
        Chats this extension started
      </h3>
      {chats === null ? null : chats.length === 0 ? (
        <p className="se-muted" style={{ margin: 0 }}>
          None yet. Summarise the project to start one.
        </p>
      ) : (
        <ul className="se-list">
          {chats.map((chat) => (
            <li key={chat.agentId} className="se-list-row">
              <button
                type="button"
                className="se-button"
                style={{ border: 'none', background: 'transparent', width: '100%', justifyContent: 'flex-start' }}
                onClick={() =>
                  void studio.host.call('tabs.focus', { workspaceId: chat.workspaceId, kind: 'chat', id: chat.agentId })
                }
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
