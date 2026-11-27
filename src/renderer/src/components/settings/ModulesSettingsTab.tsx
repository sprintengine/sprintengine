import React, { useCallback, useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'

import type { CapabilityManifest, ThirdPartyModuleView } from '../../../../shared/modules/manifest'
import { selectModuleEnabled } from '../../modules'
import { showToast } from '../../store/toastStore'
import { studioModuleSwitchStore, useWorkspaceStore } from '../../store/workspaceStore'
import { windowModuleSwitches } from '../../studio/moduleSwitches'
import type { StudioModuleSummary } from '../../../../../packages/studio-protocol/src/public'
import { ChevronDownIcon, FolderPlusIcon } from '../AppIcons'
import {
  ActionResultMessage,
  GhostButton,
  InboxSearchInput,
  LinkButton,
  MENU_LIST_CLASS,
  MenuItem,
  OutlineButton,
  PluginsGlyph,
  Popover,
  SegmentedControl,
  SettingCard,
  Switch,
  roveMenuFocus,
} from '../ui'
import { ExtensionIcon } from '../ui/ExtensionIcon'
import { ExtensionCatalogueBrowse, ExtensionCataloguePage } from './ExtensionCatalogueBrowse'
import { onExtensionPageRequest, takeExtensionPageRequest, type ExtensionPageRequest } from './extensionPageRequest'
import { useExtensionCatalogues } from './useExtensionCatalogues'
import { GitInstallDialog, type GitInstallRequest } from './GitInstallDialog'
import { extensionCatalogueApi } from '../../studio/extensionCatalogue'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import {
  accessItems,
  builtInMatchesFilter,
  matchesQuery,
  moduleMatchesFilter,
  moduleMatchesQuery,
  modulesAwaitingRestart,
  needsReview,
  publisherName,
  resolveModuleEnabled,
  restartBannerTitle,
  sourceLabel,
  type ExtensionFilter,
} from './extensionsModel'
import { ExtensionMark } from './ExtensionRow'
import { COMING_SOON_IDS, MODULE_CATEGORY_GROUPS } from './ModuleControls'
import { RestartBanner } from './RestartBanner'
import { SettingsPageHeader, SettingsSectionTitle } from './SettingsAtoms'
import {
  ExtensionGroup,
  ExtensionListRow,
  ExtensionRows,
  NoExtensionsInstalled,
  RejectedFolders,
  type ExtensionActions,
} from './ThirdPartyModuleList'
import { ApprovalReviewDialog } from './ApprovalReviewDialog'
import { useThirdPartyExtensions } from './useThirdPartyExtensions'
import { copy as appCopy } from '../../../../shared/copy'

// Settings → Extensions (route id `modules`, kept so every deep link still
// lands): everything that plugs into the app, on one page.
//
// The page title and two header actions; a restart line when an extension
// waits on the next launch; the search and the filter; then the extensions a
// person installed — the ones that need review before anything else, then the
// approved ones with their one switch — and the built-in modules folded away
// below. Short, factual labels and nothing explaining the page to itself.

// "Later" holds for the rest of the session, for the extensions it was
// pressed on. One that starts waiting afterwards brings the line back.
let restartDismissedFor: string | null = null

// Built-in modules in category order, as one list: the category headings were
// structure for a page that showed only these.
const BUILT_IN_MANIFESTS: CapabilityManifest[] = MODULE_CATEGORY_GROUPS.flatMap((group) => group.manifests)

function InstallMenu({
  installing,
  onFromFolder,
  onDevelopmentFolder,
  onFromGit,
  onBrowse,
}: {
  installing: boolean
  /** Null where the folder picked would not be on the Studio's disk (a browser tab). */
  onFromFolder: (() => void) | null
  /** A folder that loads where it is and again on every save, for building an extension. */
  onDevelopmentFolder: (() => void) | null
  /** A git repository: an extension, or a Claude Code plugin's skills and MCP servers. */
  onFromGit: (() => void) | null
  onBrowse: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const surfaceRef = useRef<HTMLElement | null>(null)
  const pick = (run: () => void) => () => {
    setOpen(false)
    run()
  }
  const rove = (event: React.KeyboardEvent) => roveMenuFocus(event, surfaceRef.current)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel={appCopy.settings.modulesSettingsTab.install}
      popupRole="menu"
      placement="bottom-end"
      surfaceClassName={`min-w-[200px] ${MENU_LIST_CLASS}`}
      onOpenAutoFocus={(surface) => {
        surfaceRef.current = surface
        surface.querySelector<HTMLElement>('[data-menu-item="true"]')?.focus()
      }}
      renderTrigger={({ ref, togglePopover, triggerProps }) => (
        <OutlineButton ref={ref} {...triggerProps} busy={installing} onClick={togglePopover}>
          {appCopy.settings.modulesSettingsTab.install}
          <ChevronDownIcon className="icon-xs shrink-0" />
        </OutlineButton>
      )}
    >
      {onFromFolder ? (
        <MenuItem icon={<FolderPlusIcon className="icon-sm" />} onClick={pick(onFromFolder)} onKeyDown={rove}>
          {appCopy.settings.modulesSettingsTab.fromAFolder}
        </MenuItem>
      ) : null}
      {onDevelopmentFolder ? (
        <MenuItem icon={<FolderPlusIcon className="icon-sm" />} onClick={pick(onDevelopmentFolder)} onKeyDown={rove}>
          As a development folder
        </MenuItem>
      ) : null}
      {onFromGit ? (
        <MenuItem icon={<FolderPlusIcon className="icon-sm" />} onClick={pick(onFromGit)} onKeyDown={rove}>
          From a git URL
        </MenuItem>
      ) : null}
      <MenuItem icon={<PluginsGlyph className="icon-sm" />} onClick={pick(onBrowse)} onKeyDown={rove}>
        From a catalogue
      </MenuItem>
    </Popover>
  )
}

/**
 * The window's Studio's word on its modules: what it holds, switched on or
 * off and whether each runs there now (`extension.list`), and a switch that waits
 * for it. Without a Studio of this window's own (a browser tab) a switch is
 * this window's copy alone.
 */
function useStudioModules(): {
  modules: ReadonlyMap<string, StudioModuleSummary>
  switchModule: (moduleId: string, enabled: boolean) => void
  failure: string | null
  dismissFailure: () => void
} {
  const setModuleEnabled = useWorkspaceStore((state) => state.setModuleEnabled)
  const [switches] = useState(() => windowModuleSwitches(studioModuleSwitchStore))
  const [modules, setModules] = useState<ReadonlyMap<string, StudioModuleSummary>>(
    () => switches?.modules() ?? new Map(),
  )
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => {
    if (!switches) return
    const stop = switches.onChange(() => setModules(switches.modules()))
    // What runs now, not what the window last heard.
    void switches.refresh()
    return stop
  }, [switches])
  const switchModule = useCallback(
    (moduleId: string, enabled: boolean) => {
      if (!switches) {
        setModuleEnabled(moduleId, enabled)
        return
      }
      setFailure(null)
      void switches.switchModule(moduleId, enabled).then((answer) => {
        if (!answer.ok) setFailure(answer.message)
      })
    },
    [setModuleEnabled, switches],
  )
  return { modules, switchModule, failure, dismissFailure: () => setFailure(null) }
}

function BuiltInRow({
  manifest,
  enabled,
  studio,
  onToggle,
}: {
  manifest: CapabilityManifest
  enabled: boolean
  /** What the window's Studio says of it, when it holds it. */
  studio: StudioModuleSummary | undefined
  onToggle: (next: boolean) => void
}): JSX.Element {
  const comingSoon = COMING_SOON_IDS.has(manifest.id)
  // On, but not running where the Studio is: say so rather than show a switch that lies.
  const notRunning = studio && studio.enabled && !studio.running ? (studio.blocked ?? 'Not running yet.') : null
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2.5">
      <ExtensionIcon name={manifest.displayName} size={28} />
      <div className="min-w-0">
        <div className="text-body font-medium text-[color:var(--text-strong)]">{manifest.displayName}</div>
        {manifest.summary ? (
          <div className="text-meta leading-4 text-[color:var(--text-muted)]">{manifest.summary}</div>
        ) : null}
        {notRunning ? (
          <div className="text-meta leading-4 text-[color:var(--text-subtle)]" data-testid="module-not-running">
            {notRunning}
          </div>
        ) : null}
      </div>
      {comingSoon ? (
        <span className="text-meta text-[color:var(--text-subtle)]">
          {appCopy.settings.modulesSettingsTab.comingSoon}
        </span>
      ) : manifest.core ? (
        <span className="text-meta text-[color:var(--text-subtle)]">
          {appCopy.settings.modulesSettingsTab.alwaysOn}
        </span>
      ) : (
        <Switch
          checked={enabled}
          onChange={onToggle}
          ariaLabel={appCopy.settings.modulesSettingsTab.enable(manifest.displayName)}
        />
      )}
    </li>
  )
}

export function ModulesSettingsTab(): JSX.Element {
  const overrides = useWorkspaceStore((state) => state.appSettings.modules)
  const studioModules = useStudioModules()
  const setModuleEnabled = studioModules.switchModule
  const extensions = useThirdPartyExtensions(setModuleEnabled)

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ExtensionFilter>('all')
  const [builtInExpanded, setBuiltInExpanded] = useState(false)
  const [reviewing, setReviewing] = useState<ThirdPartyModuleView | null>(null)
  // A folder just installed that waits for approval opens its review at once.
  const { awaitingReview, clearAwaitingReview, modules: installedModules } = extensions
  useEffect(() => {
    if (!awaitingReview) return
    const installed = installedModules.find((candidate) => candidate.manifest.id === awaitingReview)
    if (!installed) return
    clearAwaitingReview()
    setReviewing(installed)
  }, [awaitingReview, clearAwaitingReview, installedModules])
  const [detailsFor, setDetailsFor] = useState<string | null>(null)
  // A folder just installed that asks nothing opens its details instead.
  const { justInstalled, clearJustInstalled } = extensions
  useEffect(() => {
    if (!justInstalled) return
    if (!installedModules.some((candidate) => candidate.manifest.id === justInstalled)) return
    clearJustInstalled()
    setDetailsFor(justInstalled)
  }, [justInstalled, clearJustInstalled, installedModules])
  const [restartDismissed, setRestartDismissed] = useState<string | null>(restartDismissedFor)
  // Browse: the catalogues, and one extension's page in one of them.
  const [view, setView] = useState<'installed' | 'browse'>('installed')
  const [catalogueTab, setCatalogueTab] = useState('official')
  const [page, setPage] = useState<ExtensionPageRequest | null>(null)
  const catalogueState = useExtensionCatalogues(view === 'browse')
  const { confirm: confirmDialog, prompt: promptDialog } = useConfirmDialog()
  const addCatalogue = catalogueState.add
  // Adding a catalogue asks first: Studio reads it from then on, and labels
  // what it lists with its name and owner.
  const askToAddCatalogue = useCallback(
    async (url: string): Promise<string | null> => {
      if (!addCatalogue) return null
      const confirmed = await confirmDialog({
        title: url === 'community' ? 'Add the community catalogue?' : `Add catalogue ${url}?`,
        body:
          'Studio reads the extensions it lists from then on and labels them with its name and owner. ' +
          'Nothing is installed until you press Install on an extension’s page.',
        confirmLabel: 'Add catalogue',
      })
      if (!confirmed) return null
      const answer = await addCatalogue(url)
      if (!answer.ok) {
        showToast({ tone: 'error', title: 'Couldn’t add the catalogue', description: answer.message })
        return null
      }
      return answer.id
    },
    [addCatalogue, confirmDialog],
  )
  // An install link opens a page and never installs; a catalogue not added yet is asked about first.
  const openRequestedPage = useCallback(
    async (request: ExtensionPageRequest) => {
      setView('browse')
      let catalogue = request.catalogue
      // The community catalogue too, once the person removed it. Asked of the
      // Studio now: a link that opened Settings comes before its first list.
      const known = async () => {
        try {
          return (await extensionCatalogueApi.catalogues()).some((candidate) => candidate.id === catalogue)
        } catch {
          return catalogueState.catalogues.some((candidate) => candidate.id === catalogue)
        }
      }
      if ((catalogue.startsWith('git:') || catalogue === 'community') && !(await known())) {
        const added = await askToAddCatalogue(catalogue.startsWith('git:') ? catalogue.slice(4) : catalogue)
        if (!added) return
        catalogue = added
      }
      setCatalogueTab(catalogue)
      setPage({ catalogue, id: request.id })
    },
    [askToAddCatalogue, catalogueState.catalogues],
  )
  useEffect(() => {
    const take = () => {
      const request = takeExtensionPageRequest()
      if (request) void openRequestedPage(request)
    }
    take()
    return onExtensionPageRequest(take)
  }, [openRequestedPage])
  // From a git URL: the URL and an optional folder. A refusal comes back to
  // the dialog, with a marketplace's plugin folders to pick from.
  const [gitDialog, setGitDialog] = useState<{ url: string; folders: string[]; message?: string } | null>(null)
  const installFromGit = extensions.installFrom ? () => setGitDialog({ url: '', folders: [] }) : null
  const submitGitInstall = async (request: GitInstallRequest) => {
    setGitDialog(null)
    const outcome = await extensions.installFrom?.(request)
    if (outcome && !outcome.ok) {
      extensions.dismissMessage()
      setGitDialog({
        url: `${request.git}${request.ref ? `#${request.ref}` : ''}`,
        folders: outcome.folders ?? [],
        message: outcome.message,
      })
    }
  }
  const ids = { review: useId(), installed: useId(), builtIn: useId(), builtInList: useId() }

  const { modules } = extensions
  const enabledFor = useCallback((module: ThirdPartyModuleView) => resolveModuleEnabled(overrides, module), [overrides])

  // ── Restart ──
  const waiting = useMemo(() => modulesAwaitingRestart(modules, enabledFor), [modules, enabledFor])
  const waitingKey = waiting
    .map((module) => module.manifest.id)
    .sort()
    .join('\n')
  const restartTitle = waitingKey && waitingKey !== restartDismissed ? restartBannerTitle(waiting) : null
  const restartApp = window.api.restartApp

  // ── Filtering ──
  const reviewCount = modules.filter(needsReview).length
  const visibleReview = modules.filter(
    (module) => needsReview(module) && moduleMatchesQuery(module, query) && moduleMatchesFilter(module, filter, false),
  )
  const visibleInstalled = modules.filter(
    (module) =>
      !needsReview(module) &&
      moduleMatchesQuery(module, query) &&
      moduleMatchesFilter(module, filter, enabledFor(module)),
  )
  const builtInVisible = BUILT_IN_MANIFESTS.filter(
    (manifest) =>
      matchesQuery(query, manifest.displayName, manifest.summary, manifest.id) &&
      builtInMatchesFilter(filter, manifest.core === true || selectModuleEnabled(overrides, manifest.id)),
  )
  const searching = query.trim().length > 0
  const builtInOpen = builtInExpanded || (searching && builtInVisible.length > 0)
  const nothingInstalled = extensions.loaded && modules.length === 0
  const showInstalledGroup = filter !== 'review' && (visibleInstalled.length > 0 || (nothingInstalled && !searching))
  const showBuiltIn = filter !== 'review' && builtInVisible.length > 0
  const nothingMatches =
    extensions.loaded &&
    visibleReview.length === 0 &&
    !showInstalledGroup &&
    !showBuiltIn &&
    (searching || filter !== 'all')

  const actions: ExtensionActions = {
    pendingId: extensions.pendingId,
    onReview: (module) => {
      setDetailsFor(null)
      setReviewing(module)
    },
    // An installed extension's switch reaches the Studio from a browser tab too.
    onSetEnabled: extensions.setEnabled,
    onUninstall: extensions.uninstall
      ? (module) => {
          setDetailsFor(null)
          void extensions.uninstall?.(module)
        }
      : null,
    onReveal: extensions.reveal ? (module) => void extensions.reveal?.(module) : null,
    // The details close first: an update that asks again opens its review, which the popover would cover.
    onUpdate: extensions.update
      ? (module) => {
          setDetailsFor(null)
          void extensions.update?.(module)
        }
      : null,
    onCopyId: (module) => {
      void window.api
        .clipboardWriteText(module.manifest.id)
        .then(() =>
          showToast({ tone: 'neutral', title: appCopy.settings.modulesSettingsTab.copied(module.manifest.id) }),
        )
    },
  }

  // A development folder waiting to replace an installed extension is listed
  // beside it under the same id, so a row is told apart by its folder.
  const rowId = (module: ThirdPartyModuleView) =>
    module.development ? `dev:${module.development.folder}` : module.manifest.id
  const row = (module: ThirdPartyModuleView) => (
    <ExtensionListRow
      key={rowId(module)}
      module={module}
      overrides={overrides}
      actions={actions}
      detailsOpen={detailsFor === rowId(module)}
      onDetailsOpenChange={(open) =>
        setDetailsFor((current) => (open ? rowId(module) : current === rowId(module) ? null : current))
      }
    />
  )

  const reviewAccess = reviewing ? accessItems(reviewing.manifest.permissions) : { care: [], standard: [] }

  return (
    <div role="tabpanel" id="settings-panel-modules" aria-labelledby="settings-tab-modules" className="space-y-5">
      <SettingsPageHeader
        title={appCopy.settings.modulesSettingsTab.extensions}
        actions={
          <>
            <GhostButton
              onClick={() => {
                setPage(null)
                setView(view === 'browse' ? 'installed' : 'browse')
              }}
            >
              {view === 'browse' ? 'Installed' : 'Browse'}
            </GhostButton>
            <InstallMenu
              installing={extensions.installing}
              onFromFolder={extensions.installFromFolder ? () => void extensions.installFromFolder?.() : null}
              onDevelopmentFolder={
                extensions.installFromFolder ? () => void extensions.installFromFolder?.('development') : null
              }
              onFromGit={installFromGit ? () => void installFromGit() : null}
              onBrowse={() => {
                setPage(null)
                setView('browse')
              }}
            />
          </>
        }
      />

      <RestartBanner
        title={restartTitle}
        onLater={() => {
          restartDismissedFor = waitingKey
          setRestartDismissed(waitingKey)
        }}
        onRestart={
          typeof restartApp === 'function'
            ? async () => {
                await restartApp()
              }
            : null
        }
      />

      {view === 'browse' ? (
        <>
          <ActionResultMessage message={extensions.message} />
          {page ? (
            <ExtensionCataloguePage
              catalogue={page.catalogue}
              id={page.id}
              busy={extensions.installing || extensions.pendingId === page.id}
              onBack={() => setPage(null)}
              onInstall={
                extensions.installFrom
                  ? (from) =>
                      void extensions.installFrom?.(from).then((outcome) => {
                        // Installed, or refused because the catalogue lists another now: read it again.
                        void catalogueState.reload()
                        return outcome
                      })
                  : null
              }
              onUpdate={
                extensions.update
                  ? (id, version) => {
                      const module = extensions.modules.find((candidate) => candidate.manifest.id === id)
                      if (module) void extensions.update?.(module, version).then(() => catalogueState.reload())
                    }
                  : null
              }
            />
          ) : (
            <ExtensionCatalogueBrowse
              catalogues={catalogueState.catalogues}
              loading={catalogueState.loading}
              error={catalogueState.error}
              selected={catalogueTab}
              onSelect={setCatalogueTab}
              onOpen={(catalogue, id) => setPage({ catalogue, id })}
              onRefresh={catalogueState.refresh}
              onAddCatalogue={
                catalogueState.add
                  ? () =>
                      void promptDialog({
                        title: 'Add a catalogue',
                        inputLabel: 'Git URL',
                        placeholder: 'https://github.com/acme/studio-catalogue.git',
                        required: true,
                        confirmLabel: 'Continue',
                      }).then(async (url) => {
                        if (!url) return
                        const added = await askToAddCatalogue(url.trim())
                        if (added) setCatalogueTab(added)
                      })
                  : null
              }
              onRemoveCatalogue={
                catalogueState.remove
                  ? (url) =>
                      void confirmDialog({
                        title: url === 'community' ? 'Remove the community catalogue?' : `Remove catalogue ${url}?`,
                        body: 'What you installed from it stays, and no longer updates.',
                        confirmLabel: 'Remove',
                        tone: 'danger',
                      }).then((confirmed) => {
                        if (confirmed) {
                          setCatalogueTab('official')
                          void catalogueState.remove?.(url)
                        }
                      })
                  : null
              }
            />
          )}
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <InboxSearchInput
              value={query}
              onChange={setQuery}
              ariaLabel={appCopy.settings.modulesSettingsTab.searchExtensions}
              placeholder={appCopy.settings.modulesSettingsTab.searchExtensions}
            />
            <SegmentedControl<ExtensionFilter>
              ariaLabel={appCopy.settings.modulesSettingsTab.show}
              value={filter}
              onChange={setFilter}
              items={[
                { value: 'all', label: appCopy.settings.modulesSettingsTab.all },
                {
                  value: 'review',
                  label: appCopy.settings.modulesSettingsTab.needsReview,
                  badge:
                    reviewCount > 0
                      ? {
                          count: reviewCount,
                          label: appCopy.settings.modulesSettingsTab.toReview(reviewCount),
                          tone: 'neutral',
                        }
                      : null,
                },
                { value: 'on', label: appCopy.settings.modulesSettingsTab.on },
                { value: 'off', label: appCopy.settings.modulesSettingsTab.off },
              ]}
            />
          </div>

          <ActionResultMessage message={extensions.message} />
          <ActionResultMessage
            message={studioModules.failure ? { tone: 'error', text: studioModules.failure } : null}
          />

          {nothingMatches ? (
            <p className="text-body leading-5 text-[color:var(--text-muted)]">
              {searching ? (
                <>
                  {appCopy.settings.modulesSettingsTab.nothingMatches}
                  {query.trim()}&rdquo;.
                </>
              ) : (
                'Nothing here.'
              )}
            </p>
          ) : null}

          {visibleReview.length > 0 ? (
            <ExtensionGroup
              id={ids.review}
              title={appCopy.settings.modulesSettingsTab.needsReview}
              count={visibleReview.length}
            >
              <ExtensionRows label={appCopy.settings.modulesSettingsTab.needsReview}>
                {visibleReview.map(row)}
              </ExtensionRows>
            </ExtensionGroup>
          ) : null}

          {showInstalledGroup ? (
            <ExtensionGroup
              id={ids.installed}
              title={appCopy.settings.modulesSettingsTab.installed}
              count={visibleInstalled.length}
            >
              {visibleInstalled.length > 0 ? (
                <ExtensionRows label={appCopy.settings.modulesSettingsTab.installed}>
                  {visibleInstalled.map(row)}
                </ExtensionRows>
              ) : (
                <NoExtensionsInstalled />
              )}
            </ExtensionGroup>
          ) : null}

          <RejectedFolders rejected={extensions.rejected} />

          {showBuiltIn ? (
            <section aria-labelledby={ids.builtIn} className="space-y-2">
              <SettingsSectionTitle id={ids.builtIn} count={builtInVisible.length}>
                <LinkButton
                  ink="name"
                  size="inherit"
                  underline="never"
                  aria-expanded={builtInOpen}
                  aria-controls={ids.builtInList}
                  onClick={() => setBuiltInExpanded(!builtInOpen)}
                >
                  <ChevronDownIcon
                    className={`icon-sm mr-1 inline-block align-middle text-[color:var(--text-subtle)] ${builtInOpen ? '' : '-rotate-90'}`}
                  />
                  {appCopy.settings.modulesSettingsTab.builtIn}
                </LinkButton>
              </SettingsSectionTitle>
              <div id={ids.builtInList} hidden={!builtInOpen}>
                <SettingCard as="ul" ariaLabel={appCopy.settings.modulesSettingsTab.builtIn}>
                  {builtInVisible.map((manifest) => (
                    <BuiltInRow
                      key={manifest.id}
                      manifest={manifest}
                      enabled={
                        studioModules.modules.get(manifest.id)?.enabled ?? selectModuleEnabled(overrides, manifest.id)
                      }
                      studio={studioModules.modules.get(manifest.id)}
                      onToggle={(next) => setModuleEnabled(manifest.id, next)}
                    />
                  ))}
                </SettingCard>
              </div>
            </section>
          ) : null}
        </>
      )}

      {gitDialog ? (
        <GitInstallDialog
          initialUrl={gitDialog.url}
          folders={gitDialog.folders}
          {...(gitDialog.message ? { message: gitDialog.message } : {})}
          onCancel={() => setGitDialog(null)}
          onSubmit={(request) => void submitGitInstall(request)}
        />
      ) : null}
      <ApprovalReviewDialog
        module={reviewing}
        icon={reviewing ? <ExtensionMark module={reviewing} doorIcon={null} size={40} /> : null}
        meta={
          reviewing
            ? [publisherName(reviewing.manifest), sourceLabel(reviewing), `v${reviewing.manifest.version}`]
                .filter(Boolean)
                .join(' · ')
            : ''
        }
        care={reviewAccess.care}
        standard={reviewAccess.standard}
        busy={reviewing !== null && extensions.pendingId === reviewing.manifest.id}
        onCancel={() => setReviewing(null)}
        onApprove={() => {
          if (!reviewing) return
          void extensions.approveAndEnable(reviewing).then((ok) => {
            if (ok) setReviewing(null)
          })
        }}
      />
    </div>
  )
}
