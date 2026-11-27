// Add an MCP server the catalogue does not carry.
//
// This was the lower half of `ConnectorsManage`, whose upper half was the
// cross-primitive inventory. The source-tabs ruling (2026-09-05) made that
// inventory the Installed TAB of each catalogue, so what is left is the one
// thing the tab cannot express: a server nobody published, described by hand.
// It lives at the foot of the Plugins view's Installed tab, behind a
// disclosure — the rarest act on the surface, so it does not open a form over
// the list of what is already there.

import { useCallback, useState, type ReactNode } from 'react'

import { useWorkspaceStore } from '../../../store/workspaceStore'
import { Field, GhostButton, Input, OutlineButton, PrimaryButton, Select, type SelectItem } from '../../ui'
import { copy as appCopy } from '../../../../../shared/copy'

const MCP_TRANSPORT_ITEMS: SelectItem<'stdio' | 'http'>[] = [
  { value: 'stdio', label: 'stdio' },
  { value: 'http', label: 'http' },
]

// What a change did, and what syncing means: both informational, and
// information is content, not a notice — so, plain copy.
function ManageLine({ children }: { children: ReactNode }) {
  return <p className="text-body leading-5 text-[color:var(--text-muted)]">{children}</p>
}

export function CustomMcpServerForm({ activeWorkspaceRoot }: { activeWorkspaceRoot: string | null }) {
  const upsertMcpServer = useWorkspaceStore((s) => s.upsertMcpServer)

  const [mcpMessage, setMcpMessage] = useState<string | null>(null)
  const [customMcpId, setCustomMcpId] = useState('')
  const [customMcpName, setCustomMcpName] = useState('')
  const [customMcpCommand, setCustomMcpCommand] = useState('')
  const [customMcpArgs, setCustomMcpArgs] = useState('')
  const [customMcpUrl, setCustomMcpUrl] = useState('')
  const [customMcpEnv, setCustomMcpEnv] = useState('')
  const [customMcpTransport, setCustomMcpTransport] = useState<'stdio' | 'http'>('stdio')
  const [addMcpOpen, setAddMcpOpen] = useState(false)

  const addCustomMcp = useCallback(() => {
    const id = customMcpId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
    const name = customMcpName.trim() || id
    if (!id || !name) {
      setMcpMessage('Custom MCP needs an id and name.')
      return
    }
    if (customMcpTransport === 'stdio' && !customMcpCommand.trim()) {
      setMcpMessage('Stdio MCP needs a command.')
      return
    }
    if (customMcpTransport === 'http' && !customMcpUrl.trim()) {
      setMcpMessage('HTTP MCP needs a URL.')
      return
    }
    upsertMcpServer({
      id,
      name,
      transport: customMcpTransport,
      command: customMcpTransport === 'stdio' ? customMcpCommand.trim() : undefined,
      args: splitCommandArgs(customMcpArgs),
      url: customMcpTransport === 'http' ? customMcpUrl.trim() : undefined,
      envVarNames: parseEnvNames(customMcpEnv),
      enabled: true,
      required: false,
      clients: ['codex', 'claude-code'],
      scope: 'workspace',
      source: 'custom',
      riskLevel: customMcpTransport === 'stdio' ? 'local-command' : 'network',
    })
    setCustomMcpId('')
    setCustomMcpName('')
    setCustomMcpCommand('')
    setCustomMcpArgs('')
    setCustomMcpUrl('')
    setCustomMcpEnv('')
    setMcpMessage(null)
    setAddMcpOpen(false)
  }, [
    customMcpArgs,
    customMcpCommand,
    customMcpEnv,
    customMcpId,
    customMcpName,
    customMcpTransport,
    customMcpUrl,
    upsertMcpServer,
  ])

  return (
    <section className="space-y-3 border-t border-[color:var(--border-subtle)] pt-5">
      {!addMcpOpen ? (
        <OutlineButton size="sm" onClick={() => setAddMcpOpen(true)}>
          {appCopy.panels.connectorsPanel.customMcpServerForm.addACustomMCP}
        </OutlineButton>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={appCopy.panels.connectorsPanel.customMcpServerForm.serverId} htmlFor="custom-mcp-id">
              <Input
                value={customMcpId}
                onChange={(event) => setCustomMcpId(event.target.value)}
                placeholder="server-id"
                size="md"
                className="font-mono"
              />
            </Field>
            <Field label={appCopy.panels.connectorsPanel.customMcpServerForm.displayName} htmlFor="custom-mcp-name">
              <Input
                value={customMcpName}
                onChange={(event) => setCustomMcpName(event.target.value)}
                placeholder={appCopy.panels.connectorsPanel.customMcpServerForm.displayName}
                size="md"
              />
            </Field>
            <Field label={appCopy.panels.connectorsPanel.customMcpServerForm.transport} htmlFor="custom-mcp-transport">
              <Select
                ariaLabel={appCopy.panels.connectorsPanel.customMcpServerForm.transport}
                items={MCP_TRANSPORT_ITEMS}
                value={customMcpTransport}
                onChange={setCustomMcpTransport}
                className="h-control-md w-full"
              />
            </Field>
            <Field
              label={
                customMcpTransport === 'stdio'
                  ? appCopy.panels.connectorsPanel.customMcpServerForm.command
                  : appCopy.panels.connectorsPanel.customMcpServerForm.uRL
              }
              htmlFor="custom-mcp-endpoint"
            >
              {customMcpTransport === 'stdio' ? (
                <Input
                  value={customMcpCommand}
                  onChange={(event) => setCustomMcpCommand(event.target.value)}
                  placeholder={appCopy.panels.connectorsPanel.customMcpServerForm.eGNpx}
                  size="md"
                  className="font-mono"
                />
              ) : (
                <Input
                  value={customMcpUrl}
                  onChange={(event) => setCustomMcpUrl(event.target.value)}
                  placeholder="https://example.com/mcp"
                  size="md"
                  className="font-mono"
                />
              )}
            </Field>
            <div className="sm:col-span-2">
              <Field
                label={appCopy.panels.connectorsPanel.customMcpServerForm.argsSpaceSeparated}
                htmlFor="custom-mcp-args"
              >
                <Input
                  value={customMcpArgs}
                  onChange={(event) => setCustomMcpArgs(event.target.value)}
                  placeholder={appCopy.panels.connectorsPanel.customMcpServerForm.eGYVendorServer}
                  size="md"
                  className="font-mono"
                />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field
                label={appCopy.panels.connectorsPanel.customMcpServerForm.requiredEnvVarsCommaSeparated}
                htmlFor="custom-mcp-env"
              >
                <Input
                  value={customMcpEnv}
                  onChange={(event) => setCustomMcpEnv(event.target.value)}
                  placeholder={appCopy.panels.connectorsPanel.customMcpServerForm.aPIKEYANOTHERVAR}
                  size="md"
                  className="font-mono"
                />
              </Field>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <GhostButton
              size="sm"
              onClick={() => {
                setAddMcpOpen(false)
                setMcpMessage(null)
              }}
            >
              {appCopy.panels.connectorsPanel.customMcpServerForm.cancel}
            </GhostButton>
            <PrimaryButton size="sm" onClick={addCustomMcp}>
              {appCopy.panels.connectorsPanel.customMcpServerForm.addServer}
            </PrimaryButton>
          </div>
        </>
      )}

      <ManageLine>
        {mcpMessage ||
          (activeWorkspaceRoot
            ? 'Terminals that are already running keep their old MCP settings until you restart them.'
            : 'Open a workspace folder to sync MCPs to terminal agents.')}
      </ManageLine>
    </section>
  )
}

function splitCommandArgs(value: string): string[] {
  return value
    .split(/\s+/u)
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseEnvNames(value: string): string[] {
  return value
    .split(/\r?\n|,/u)
    .map((item) => item.trim())
    .filter(Boolean)
}
