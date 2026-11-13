import { useCallback, useEffect, useId, useState } from 'react'

import { MCP_HTTP_CLIENT_NAME_MAX, mcpHttpClientConfig, type McpHttpStatus } from '../../../../shared/mcp-http'
import { STUDIO_MCP_SERVER_ID } from '../../../../shared/product-identity'
import { clientSupports } from '../../clientCapabilities'
import { accessApi } from '../../studio/access'
import { formatRelativeMsAgo } from '../../utils/relativeTime'
import { Field, GhostButton, InlineNotice, Input, OutlineButton, PrimaryButton, useConfirmDialog } from '../ui'
import { SettingCard, SettingsRow } from './SettingsAtoms'

// Settings → MCPs: the gateway over loopback HTTP, for an MCP client that
// takes a URL. Each client gets a token of its own, named for it here, and
// "Copy MCP URL" puts the URL and that token on the clipboard together: the
// token is kept only hashed, so this is the one time it can be copied.
//
// A token is minted at Studio's own desktop window only (`mcpHttp.create` is
// a window's): a web tab lists and revokes the clients, and says where a new
// one is made.

export function McpHttpSettings() {
  const [status, setStatus] = useState<McpHttpStatus | null>(null)
  const [name, setName] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const dialog = useConfirmDialog()
  const nameId = useId()

  const refresh = useCallback(async () => {
    try {
      setStatus(await accessApi.mcpHttpStatus())
    } catch {
      // Status stays unknown; the rows do not render.
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!status) return null
  // The desktop's own window, which alone may mint a token.
  const mints = clientSupports('tailnet-admin')

  const create = async () => {
    if (name === null) return
    setError(null)
    try {
      const made = await accessApi.mcpHttpCreate(name)
      setStatus(made.status)
      if (!made.ok) {
        setError(made.message)
        return
      }
      await window.api.clipboardWriteText(mcpHttpClientConfig(STUDIO_MCP_SERVER_ID, made.url, made.token))
      setCopied(made.client.name)
      setName(null)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The token could not be made.')
    }
  }

  const revoke = async (id: string, clientName: string) => {
    const confirmed = await dialog.confirm({
      title: `Revoke ${clientName}?`,
      body: 'Its token stops working at once. Copy a new MCP URL to let it back in.',
      confirmLabel: 'Revoke',
      tone: 'danger',
    })
    if (!confirmed) return
    setCopied(null)
    setStatus(await accessApi.mcpHttpRevoke(id))
  }

  const now = Date.now()
  return (
    <>
      <SettingCard>
        <SettingsRow
          label="MCP over HTTP"
          help={
            status.url ? (
              <span className="break-all font-mono text-meta">{status.url}</span>
            ) : (
              'For an MCP client that takes a URL. Listens on this computer only, once a client has a token.'
            )
          }
        >
          <span className="text-body text-[color:var(--text-muted)]">{status.running ? 'On' : 'Off'}</span>
        </SettingsRow>
        {status.clients.map((client) => (
          <SettingsRow
            key={client.id}
            label={client.name}
            help={client.lastUsedAt ? `Last used ${formatRelativeMsAgo(client.lastUsedAt, now)}` : 'Not used yet'}
          >
            <GhostButton tone="danger" onClick={() => void revoke(client.id, client.name)}>
              Revoke
            </GhostButton>
          </SettingsRow>
        ))}
        {name !== null ? (
          <SettingsRow label="Copy MCP URL" help="Name the client this token is for." stacked>
            <div className="space-y-3">
              <Field label="Client" htmlFor={nameId}>
                <Input
                  id={nameId}
                  value={name}
                  maxLength={MCP_HTTP_CLIENT_NAME_MAX}
                  placeholder="editor"
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && name.trim()) void create()
                  }}
                />
              </Field>
              <div className="flex items-center gap-2">
                <PrimaryButton disabled={!name.trim()} onClick={() => void create()}>
                  Copy MCP URL
                </PrimaryButton>
                <GhostButton onClick={() => setName(null)}>Cancel</GhostButton>
              </div>
            </div>
          </SettingsRow>
        ) : null}
      </SettingCard>
      {name === null && !mints ? (
        <p className="text-meta text-[color:var(--text-muted)]">A new MCP URL is made in the desktop app.</p>
      ) : null}
      {name === null && mints ? (
        <OutlineButton
          onClick={() => {
            setCopied(null)
            setError(null)
            setName('')
          }}
        >
          Copy MCP URL
        </OutlineButton>
      ) : null}
      {copied ? (
        <p role="status" className="text-meta text-[color:var(--text-muted)]">
          {`Copied the URL and a token for ${copied}. Paste it into that client's MCP settings; the token is not shown again.`}
        </p>
      ) : null}
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      {status.lastError ? <InlineNotice tone="error">{status.lastError}</InlineNotice> : null}
    </>
  )
}
