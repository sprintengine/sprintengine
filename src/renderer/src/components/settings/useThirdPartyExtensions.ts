import { useCallback, useEffect, useState } from 'react'

import type { MarketplaceUpdateStatesResult } from '../../../../shared/electron-api'
import { errorMessage } from '../../../../shared/errors'
import type { ModuleManifestIssue, ThirdPartyModuleView } from '../../../../shared/modules/manifest'
import { getRendererHost, onThirdPartyRendererModulesLoaded, refreshThirdPartyRendererModules } from '../../modules'
import { showToast } from '../../store/toastStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { ExtensionTrustReviewData } from '../extensions/ExtensionTrustReview'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import type { ActionResult } from '../ui'
import { windowModuleLifecycle } from '../../studio/moduleLifecycle'
import { addThirdPartyModuleFromFolder } from './addThirdPartyModuleFromFolder'
import type { ExtensionUpdate } from './extensionsModel'
import { classifyVerification, summarizeInstallResult } from './installFlow'
import { extensionsApi, windowHasStudio } from '../../studio/extensions'

// Settings → Extensions, the third-party half. It lists (the shell's view of
// what is on disk) and updates (the marketplace's); it installs, trusts,
// revokes and uninstalls through the window's Studio (`module.*`), which owns
// what runs there. The page and
// its rows only render what this hands them. The trust, uninstall and update
// semantics are the ones Settings → Modules had — the presentation moved, the
// rules did not.

/** An update paused on the trust disclosure: the new version is signed differently. */
export type UpdateTrustPause = {
  module: ThirdPartyModuleView
  update: ExtensionUpdate
  review: ExtensionTrustReviewData
  trustToken: string
}

export function useThirdPartyExtensions(onSetEnabled: (moduleId: string, enabled: boolean) => void) {
  const [modules, setModules] = useState<ThirdPartyModuleView[]>([])
  const [rejected, setRejected] = useState<Array<{ path: string; issues: ModuleManifestIssue[] }>>([])
  const [loaded, setLoaded] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [message, setMessage] = useState<ActionResult | null>(null)
  // null until the first read lands, or forever on a build without the API:
  // no update is claimed either way.
  const [updateStates, setUpdateStates] = useState<MarketplaceUpdateStatesResult | null>(null)
  const [updatePause, setUpdatePause] = useState<UpdateTrustPause | null>(null)

  // An uninstall that takes out a bundle's MCP servers or skill copies writes
  // into the project they were installed for, so it carries the same envelope
  // an install does: the open project and the MCP settings.
  const workspaceRoot = useWorkspaceStore(
    (state) => state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId)?.folderPath ?? null,
  )
  const mcpSettings = useWorkspaceStore((state) => state.appSettings.mcp)
  const removeMcpServer = useWorkspaceStore((state) => state.removeMcpServer)
  const upsertMcpServer = useWorkspaceStore((state) => state.upsertMcpServer)
  const forgetModules = useWorkspaceStore((state) => state.forgetModules)
  const { confirm: confirmDialog } = useConfirmDialog()
  const [lifecycle] = useState(() => windowModuleLifecycle())

  const load = useCallback(async () => {
    if (!windowHasStudio()) {
      setLoaded(true)
      return
    }
    try {
      const result = await extensionsApi.listThirdPartyModules()
      setModules(result.modules)
      setRejected(result.rejected)
    } catch (error) {
      setMessage({ tone: 'error', text: errorMessage(error, 'Couldn’t list installed extensions.') })
    } finally {
      setLoaded(true)
    }
  }, [])

  const loadUpdateStates = useCallback(async (forceRefresh = false) => {
    if (!windowHasStudio()) return
    try {
      setUpdateStates(
        await extensionsApi.readMarketplacePluginUpdateStates(forceRefresh ? { forceRefresh: true } : undefined),
      )
    } catch {
      setUpdateStates(null)
    }
  }, [])

  useEffect(() => {
    void load()
    void loadUpdateStates()
  }, [load, loadUpdateStates])
  // A renderer batch that landed after the first list (trust granted, a slow
  // boot) changes what the rows say about running.
  useEffect(() => onThirdPartyRendererModulesLoaded(() => void load()), [load])
  // What is installed changed under the window: an install elsewhere, or a
  // module copied into the drop-in folder while Studio runs.
  useEffect(
    () => (windowHasStudio() ? extensionsApi.onThirdPartyModulesChanged(() => void load()) : undefined),
    [load],
  )

  const installFromFolder = useCallback(async () => {
    setInstalling(true)
    setMessage(null)
    try {
      const result = await addThirdPartyModuleFromFolder(window.api, lifecycle)
      if (result.status === 'failed') setMessage({ tone: 'error', text: result.message })
      if (result.status === 'installed') await load()
    } finally {
      setInstalling(false)
    }
  }, [lifecycle, load])

  // Trust and turn on, in one step: the review is the consent, and a trusted
  // module left off would make the person find a second switch for the same
  // decision. Trust is still written first and on its own, so a failed grant
  // never turns anything on.
  const trustAndEnable = useCallback(
    async (module: ThirdPartyModuleView): Promise<boolean> => {
      if (!lifecycle) return false
      const id = module.manifest.id
      setPendingId(id)
      setMessage(null)
      try {
        const result = await lifecycle.setTrust(id, true)
        if (!result.ok) {
          setMessage({ tone: 'error', text: result.message ?? `Couldn’t trust ${module.manifest.displayName}.` })
          return false
        }
        onSetEnabled(id, true)
        await refreshThirdPartyRendererModules()
        await load()
        return true
      } catch (error) {
        setMessage({ tone: 'error', text: errorMessage(error, 'Couldn’t update trust.') })
        return false
      } finally {
        setPendingId(null)
      }
    },
    [lifecycle, load, onSetEnabled],
  )

  const revokeTrust = useCallback(
    async (module: ThirdPartyModuleView) => {
      if (!lifecycle) return
      const id = module.manifest.id
      // Revoking unloads the module's workspace types on next launch: name the
      // workspaces that would lose their surface (nothing on disk is touched,
      // and trusting it again brings them back).
      const kernel = getRendererHost()
      const affected = useWorkspaceStore
        .getState()
        .workspaces.filter((workspace) => kernel.getWorkspaceTypeModule(workspace.mode) === id)
      if (affected.length > 0) {
        const confirmed = await confirmDialog({
          title: `Revoke trust in ${module.manifest.displayName}?`,
          body: `These workspaces use it and show “module not installed” until you trust it again. Their files stay on disk: ${affected
            .map((workspace) => workspace.name)
            .join(', ')}.`,
          confirmLabel: 'Revoke trust',
          tone: 'danger',
        })
        if (!confirmed) return
      }
      setPendingId(id)
      setMessage(null)
      try {
        const result = await lifecycle.setTrust(id, false)
        if (!result.ok) setMessage({ tone: 'error', text: result.message ?? 'Couldn’t update trust.' })
        await load()
      } finally {
        setPendingId(null)
      }
    },
    [confirmDialog, lifecycle, load],
  )

  const canUninstall = lifecycle !== null

  // Uninstall, however the module arrived. One a marketplace or GitHub install
  // put in place belongs to that plugin, and the plugin's own uninstall takes
  // it out with the rest of its bundle (its skill copies and MCP servers). One
  // added from a folder is removed by the Studio (`module.uninstall`), which
  // also names the plugin when it finds one this list did not know. Either
  // way its trust grant, enablement and stored secrets go too, and what this
  // window keeps for it is dropped.
  const removeThroughPlugin = useCallback(
    async (pluginId: string): Promise<{ ok: true; removedModuleIds: string[] } | { ok: false; message: string }> => {
      if (!windowHasStudio()) return { ok: false, message: 'Uninstalling plugins needs a newer build.' }
      const result = await extensionsApi.uninstallMarketplacePlugin({
        pluginId,
        ...(workspaceRoot ? { workspaceRoot } : {}),
        mcpSettings,
      })
      // Servers the bundle added and main just took out of the configs.
      if (result.mcpSettings) {
        for (const id of Object.keys(mcpSettings.servers)) {
          if (!(id in result.mcpSettings.servers)) removeMcpServer(id)
        }
      }
      if (!result.ok) return { ok: false, message: result.message }
      return {
        ok: true,
        removedModuleIds: result.removed
          .filter((component) => component.kind === 'module')
          .map((component) => component.id),
      }
    },
    [workspaceRoot, mcpSettings, removeMcpServer],
  )

  const uninstall = useCallback(
    async (module: ThirdPartyModuleView) => {
      if (!lifecycle) return
      const name = module.manifest.displayName
      const confirmed = await confirmDialog({
        title: `Uninstall ${name}?`,
        // What leaves and what stays. What the app kept for it outside any
        // project is deleted, so a module installed under the same id later
        // starts empty; work it saved inside a project is the person's and is
        // never touched — saying so is what makes the button pressable.
        body:
          'Its files and anything else its plugin installed are removed, with its settings, the data it stored ' +
          'outside your projects and the keys you gave it. Work it saved in your projects stays. Code already ' +
          'running stops at the next restart.',
        confirmLabel: 'Uninstall',
        tone: 'danger',
      })
      if (!confirmed) return
      setPendingId(module.manifest.id)
      setMessage(null)
      try {
        const origin = module.origin
        let result: { ok: true; removedModuleIds: string[] } | { ok: false; message: string }
        if (origin && origin.kind !== 'folder') result = await removeThroughPlugin(origin.pluginId)
        else {
          const removed = await lifecycle.uninstall(module.manifest.id)
          result = !removed.ok && removed.pluginId ? await removeThroughPlugin(removed.pluginId) : removed
        }
        if (result.ok) {
          forgetModules(result.removedModuleIds)
          if (module.launch.mainLoaded) {
            showToast({ tone: 'neutral', title: `Uninstalled ${name}`, description: 'It stops at the next restart.' })
          }
        } else {
          setMessage({ tone: 'error', text: result.message || `Couldn’t uninstall ${name}.` })
        }
        await load()
      } catch (error) {
        setMessage({ tone: 'error', text: errorMessage(error, 'Uninstall failed.') })
      } finally {
        setPendingId(null)
      }
    },
    [confirmDialog, lifecycle, load, forgetModules, removeThroughPlugin],
  )

  const reveal = useCallback(async (module: ThirdPartyModuleView) => {
    if (typeof window.api.revealThirdPartyModule !== 'function') return
    const result = await window.api.revealThirdPartyModule(module.manifest.id)
    if (!result.ok) setMessage({ tone: 'error', text: result.message ?? 'Couldn’t open its folder.' })
  }, [])

  // The marketplace update, through the same verify-then-update path the
  // Plugins door uses: a new version signed by a different key (or unsigned
  // where it was signed) pauses on the disclosure; a blocked one says why.
  // Never a silent grant and never a fake success.
  const runUpdate = useCallback(
    async (module: ThirdPartyModuleView, update: ExtensionUpdate, trustToken?: string) => {
      if (!windowHasStudio()) {
        setMessage({ tone: 'error', text: 'Updating extensions needs a newer build.' })
        return
      }
      setPendingId(module.manifest.id)
      setMessage(null)
      try {
        let token = trustToken
        if (!token && windowHasStudio()) {
          const verify = await extensionsApi.verifyMarketplacePlugin({ id: update.pluginId })
          // A module bundle is code: the unsigned split treats it as such even
          // if the verifier's own flag were missing.
          const outcome = classifyVerification(verify, ['module'])
          if (outcome.kind === 'blocked') {
            setMessage({ tone: outcome.classification === 'invalid' ? 'error' : 'warn', text: outcome.message })
            return
          }
          if (outcome.kind === 'needs-trust') {
            setUpdatePause({ module, update, review: outcome.review, trustToken: outcome.trustToken })
            return
          }
          token = outcome.trustToken
        }
        const result = await extensionsApi.updateMarketplacePluginFromRegistry({
          id: update.pluginId,
          ...(token ? { trustToken: token } : {}),
          workspaceRoot: workspaceRoot ?? undefined,
          mcpSettings,
        })
        if (!result.ok) {
          const summary = summarizeInstallResult(result)
          setMessage({
            tone: summary.status === 'blocked' && summary.classification === 'unsigned' ? 'warn' : 'error',
            text:
              summary.status === 'blocked' || summary.status === 'error'
                ? summary.message
                : 'The update couldn’t be completed.',
          })
        } else if (result.mcpSettings) {
          for (const server of Object.values(result.mcpSettings.servers)) upsertMcpServer(server)
        }
        await Promise.all([load(), loadUpdateStates(true)])
      } catch (error) {
        setMessage({ tone: 'error', text: errorMessage(error, 'The update couldn’t be completed.') })
      } finally {
        setPendingId(null)
      }
    },
    [load, loadUpdateStates, mcpSettings, upsertMcpServer, workspaceRoot],
  )

  const confirmUpdateTrust = useCallback(async () => {
    const pause = updatePause
    if (!pause) return
    setUpdatePause(null)
    await runUpdate(pause.module, pause.update, pause.trustToken)
  }, [runUpdate, updatePause])

  return {
    modules,
    rejected,
    loaded,
    installing,
    pendingId,
    message,
    dismissMessage: () => setMessage(null),
    updateStates,
    updatePause,
    cancelUpdateTrust: () => setUpdatePause(null),
    confirmUpdateTrust,
    installFromFolder,
    trustAndEnable,
    revokeTrust,
    uninstall: canUninstall ? uninstall : null,
    reveal: typeof window.api.revealThirdPartyModule === 'function' ? reveal : null,
    update: runUpdate,
    reload: load,
  }
}
