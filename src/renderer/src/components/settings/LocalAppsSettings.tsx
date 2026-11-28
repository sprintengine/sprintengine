import { useCallback, useEffect, useId, useState } from 'react'

import type { StudioScope } from '../../../../../packages/studio-protocol/src/public'
import type { CliPermissionPreset } from '../../../../shared/cli-permission-preset'
import type {
  StudioLocalAppOfferView,
  StudioLocalAppToolReach,
  StudioLocalAppToolset,
  StudioLocalAppsStatus,
} from '../../../../shared/studio-local-apps'
import { accessApi } from '../../studio/access'
import { formatRelativeMsAgo, relativeFromNow } from '../../utils/relativeTime'
import {
  CopyGlyphButton,
  DescribedCheckRow,
  DescribedCheckRowList,
  Field,
  GhostButton,
  InlineNotice,
  Input,
  OutlineButton,
  PrimaryButton,
  ScopePill,
  ScopePillSet,
  Select,
  useConfirmDialog,
} from '../ui'
import { AGENT_SPAWN_PERMISSION_OPTIONS, PRESET_CHIP_LABEL } from '../workspace/agentComposer/agentSpawnShared'
import { SettingCard, SettingsRow, SettingsSectionTitle } from './SettingsAtoms'
import { copy } from '../../../../shared/copy'

// Settings → Agents, under the MCP gateway: the applications on this machine
// paired with Studio's owner socket (the Studio RPC that @sprintengine/agent-sdk
// speaks). Each row says what the app may do — its scopes, and the loosest
// preset its chats may run on — and whether it is connected, and revokes it.
// Pairing mints a one-time code the app presents once; the code is shown here
// that once and is never readable again.

const SCOPE_ROWS: Array<{ scope: StudioScope; title: string; description: string }> = [
  {
    scope: 'conversation:read',
    title: copy.settings.localAppsSettings.readChats,
    description: copy.settings.localAppsSettings.seeThisMachineSChats,
  },
  {
    scope: 'conversation:operate',
    title: copy.settings.localAppsSettings.driveChats,
    description: copy.settings.localAppsSettings.sendMessagesAnswerApprovalsChange,
  },
  {
    scope: 'conversation:create',
    title: copy.settings.localAppsSettings.startChats,
    description: copy.settings.localAppsSettings.startNewChatsWithA,
  },
  {
    scope: 'tools:offer',
    title: copy.settings.localAppsSettings.giveAgentsToolsFromThis,
    description: copy.settings.localAppsSettings.offerToolsThatRunIn,
  },
  {
    scope: 'environment:maintain',
    title: copy.settings.localAppsSettings.updateStudio,
    description: copy.settings.localAppsSettings.installUpdatesAndRestartRunning,
  },
  {
    scope: 'settings:write',
    title: copy.settings.localAppsSettings.changeSettings,
    description: copy.settings.localAppsSettings.setOrRemoveAPIKeys,
  },
  {
    scope: 'extensions:read',
    title: copy.settings.localAppsSettings.hearExtensions,
    description: copy.settings.localAppsSettings.receiveExtensionsEventsAndNotificati,
  },
  {
    scope: 'extensions:operate',
    title: copy.settings.localAppsSettings.useExtensions,
    description: copy.settings.localAppsSettings.runExtensionsActionsThatChange,
  },
]

const REACH_ITEMS: Array<{ value: StudioLocalAppToolReach; label: string }> = [
  { value: 'own', label: copy.settings.localAppsSettings.theChatsItStarts },
  { value: 'all', label: copy.settings.localAppsSettings.everyChatAndTerminalAgent },
]

const TOOLSET_STATE: Record<StudioLocalAppToolset['state'], string> = {
  offered: 'offered',
  reconnecting: 'reconnecting',
  not_offered: 'not offered now',
}

/** One line per toolset an app gives agents: its name, how many tools, and whether it is there now. */
function toolsetsLine(toolsets: StudioLocalAppToolset[]): string {
  return toolsets
    .map(
      (toolset) =>
        `${toolset.title} (${toolset.name}) · ${toolset.tools === 1 ? '1 tool' : `${toolset.tools} tools`} · ${TOOLSET_STATE[toolset.state]}`,
    )
    .join('\n')
}

const CEILING_ITEMS = AGENT_SPAWN_PERMISSION_OPTIONS.map((option) => ({
  value: option.value as CliPermissionPreset,
  label: option.label,
  ...(option.value === 'bypass' ? { tone: 'warn' as const } : {}),
}))

type Draft = { name: string; scopes: StudioScope[]; ceiling: CliPermissionPreset; toolReach: StudioLocalAppToolReach }
const EMPTY_DRAFT: Draft = {
  name: '',
  scopes: ['conversation:read', 'conversation:operate'],
  ceiling: 'auto',
  toolReach: 'own',
}

export function LocalAppsSettings() {
  const [status, setStatus] = useState<StudioLocalAppsStatus | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [minted, setMinted] = useState<StudioLocalAppOfferView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const dialog = useConfirmDialog()
  const nameId = useId()

  const refresh = useCallback(async () => {
    try {
      setStatus(await accessApi.studioLocalAppsStatus())
    } catch {
      // Status stays unknown; the section does not render.
    }
  }, [])

  useEffect(() => {
    void refresh()
    return accessApi.onStudioLocalAppsChanged((next) => {
      setStatus(next)
      // A code redeemed or cancelled from anywhere is no longer one to show.
      setMinted((current) => (current && next.offers.some((offer) => offer.id === current.offer.id) ? current : null))
    })
  }, [refresh])

  // Ticks only while a code's expiry is on screen.
  useEffect(() => {
    if (!status?.offers.length) return undefined
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [status?.offers.length])

  if (!status) return null

  const pair = async () => {
    if (!draft) return
    setError(null)
    try {
      const view = await accessApi.studioLocalAppsOffer(draft)
      setMinted(view)
      setStatus(view.status)
      setDraft(null)
      setNow(Date.now())
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Couldn’t make a pairing code.')
    }
  }

  const revoke = async (id: string, name: string) => {
    const confirmed = await dialog.confirm({
      title: copy.settings.localAppsSettings.revoke(name),
      body: copy.settings.localAppsSettings.itSDisconnectedAtOnce,
      confirmLabel: copy.settings.localAppsSettings.revoke2,
      tone: 'danger',
    })
    if (!confirmed) return
    setStatus(await accessApi.studioLocalAppsRevoke(id))
  }

  const toggleScope = (scope: StudioScope, on: boolean) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            scopes: on ? [...new Set([...current.scopes, scope])] : current.scopes.filter((held) => held !== scope),
          }
        : current,
    )

  const empty = status.apps.length === 0 && status.offers.length === 0
  // Pairing and revoking belong to the Studio serving the socket. Another one
  // on the same profile (a second dev build) would write the same store under
  // it, so here they are shown and not offered.
  const elsewhere = !status.running && status.lastError !== null

  return (
    <section className="space-y-3 pt-2">
      <SettingsSectionTitle>{copy.settings.localAppsSettings.localApps}</SettingsSectionTitle>
      <SettingCard>
        {status.apps.map((app) => {
          const seen = app.connected
            ? 'Connected'
            : app.lastSeenAt
              ? `Last seen ${formatRelativeMsAgo(Date.parse(app.lastSeenAt), now)}`
              : 'Not connected yet'
          return (
            <SettingsRow
              key={app.id}
              label={app.name}
              help={`${seen} · chats up to ${PRESET_CHIP_LABEL[app.ceiling]}`}
              stacked
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <ScopePillSet ariaLabel={copy.settings.localAppsSettings.whatMayDo(app.name)}>
                  {app.scopes.map((scope) => (
                    <ScopePill key={scope} scope={scope} />
                  ))}
                </ScopePillSet>
                <GhostButton tone="danger" disabled={!status.running} onClick={() => void revoke(app.id, app.name)}>
                  {copy.settings.localAppsSettings.revoke2}
                </GhostButton>
              </div>
              {app.scopes.includes('tools:offer') ? (
                <div className="mt-2 space-y-2">
                  <p className="whitespace-pre-line text-meta text-[color:var(--text-muted)]">
                    {app.toolsets.length > 0 ? toolsetsLine(app.toolsets) : 'Has not offered any tools yet.'}
                  </p>
                  <Field label={copy.settings.localAppsSettings.itsToolsReach}>
                    <Select
                      ariaLabel={copy.settings.localAppsSettings.whichAgentsSToolsReach(app.name)}
                      items={REACH_ITEMS}
                      value={app.toolReach}
                      disabled={!status.running}
                      onChange={(reach) => void accessApi.studioLocalAppsSetReach(app.id, reach).then(setStatus)}
                    />
                  </Field>
                </div>
              ) : null}
            </SettingsRow>
          )
        })}
        {status.offers.map((offer) => (
          <SettingsRow
            key={offer.id}
            label={offer.name}
            help={`Waiting to pair · the code expires ${relativeFromNow(Date.parse(offer.expiresAt), now)}`}
          >
            <GhostButton onClick={() => void accessApi.studioLocalAppsCancelOffer(offer.id).then(setStatus)}>
              {copy.settings.localAppsSettings.cancel}
            </GhostButton>
          </SettingsRow>
        ))}
        {empty ? (
          <SettingsRow
            label={copy.settings.localAppsSettings.noAppsArePaired}
            help="When a script or app built with @sprintengine/agent-sdk pairs with Studio, it will be listed here."
          >
            <span className="text-body text-[color:var(--text-muted)]">{status.running ? 'Ready' : 'Off'}</span>
          </SettingsRow>
        ) : null}
      </SettingCard>

      {minted ? (
        <SettingCard>
          <SettingsRow
            label={copy.settings.localAppsSettings.pairingCodeFor(minted.offer.name)}
            help="Give it to the app as its pairing code. It works once, for ten minutes, and is not shown again."
            stacked
          >
            <div className="flex items-center gap-2">
              <span className="break-all font-mono text-meta">{minted.code}</span>
              <CopyGlyphButton text={minted.code} label={copy.settings.localAppsSettings.copyThePairingCode} />
            </div>
          </SettingsRow>
        </SettingCard>
      ) : null}

      {draft ? (
        <SettingCard>
          <SettingsRow label={copy.settings.localAppsSettings.pairAnApp} stacked>
            <div className="space-y-3">
              <Field label={copy.settings.localAppsSettings.name} htmlFor={nameId}>
                <Input
                  value={draft.name}
                  placeholder="release-bot"
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </Field>
              <DescribedCheckRowList ariaLabel={copy.settings.localAppsSettings.whatTheAppMayDo}>
                {SCOPE_ROWS.map((row) => (
                  <DescribedCheckRow
                    key={row.scope}
                    id={`local-app-scope-${row.scope}`}
                    title={row.title}
                    code={row.scope}
                    description={row.description}
                    checked={draft.scopes.includes(row.scope)}
                    onChange={(next) => toggleScope(row.scope, next)}
                  />
                ))}
              </DescribedCheckRowList>
              {draft.scopes.includes('tools:offer') ? (
                <Field label={copy.settings.localAppsSettings.itsToolsReach}>
                  <Select
                    ariaLabel={copy.settings.localAppsSettings.whichAgentsItsToolsReach}
                    items={REACH_ITEMS}
                    value={draft.toolReach}
                    onChange={(toolReach) => setDraft({ ...draft, toolReach })}
                  />
                </Field>
              ) : null}
              <Field label={copy.settings.localAppsSettings.loosestPresetItsChatsMay}>
                <Select
                  ariaLabel={copy.settings.localAppsSettings.loosestPresetItsChatsMay}
                  items={CEILING_ITEMS}
                  value={draft.ceiling}
                  onChange={(ceiling) => setDraft({ ...draft, ceiling })}
                />
              </Field>
              <div className="flex items-center gap-2">
                <PrimaryButton disabled={!draft.name.trim() || draft.scopes.length === 0} onClick={() => void pair()}>
                  {copy.settings.localAppsSettings.makePairingCode}
                </PrimaryButton>
                <GhostButton onClick={() => setDraft(null)}>{copy.settings.localAppsSettings.cancel}</GhostButton>
              </div>
            </div>
          </SettingsRow>
        </SettingCard>
      ) : (
        <OutlineButton
          disabled={!status.running}
          onClick={() => {
            setMinted(null)
            setDraft(EMPTY_DRAFT)
          }}
        >
          {copy.settings.localAppsSettings.pairAnApp}
        </OutlineButton>
      )}

      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      {status.lastError ? (
        <InlineNotice tone="error">
          {elsewhere
            ? `${status.lastError} Pair and revoke apps from the Studio that is serving it.`
            : status.lastError}
        </InlineNotice>
      ) : null}
    </section>
  )
}
