import { useCallback, useEffect, useState } from 'react'

import { errorMessage } from '../../../../shared/errors'
import type { ModuleManifestIssue, ThirdPartyModuleView } from '../../../../shared/modules/manifest'
import { getRendererHost, onThirdPartyRendererModulesLoaded, refreshThirdPartyRendererModules } from '../../modules'
import { showToast } from '../../store/toastStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import type { ActionResult } from '../ui'
import { windowModuleLifecycle } from '../../studio/moduleLifecycle'
import { addThirdPartyModuleFromFolder } from './addThirdPartyModuleFromFolder'
import { extensionsApi, windowHasStudio } from '../../studio/extensions'
import { copy } from '../../../../shared/copy'

// Settings → Extensions, the third-party half. It lists what is installed,
// and installs, trusts, revokes and uninstalls through the window's Studio
// (`extension.*`), which owns what runs there. The page and its rows only
// render what this hands them.

export function useThirdPartyExtensions(onSetEnabled: (moduleId: string, enabled: boolean) => void) {
  const [modules, setModules] = useState<ThirdPartyModuleView[]>([])
  const [rejected, setRejected] = useState<Array<{ path: string; issues: ModuleManifestIssue[] }>>([])
  const [loaded, setLoaded] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [message, setMessage] = useState<ActionResult | null>(null)
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

  useEffect(() => {
    void load()
  }, [load])
  // A renderer batch that landed after the first list (trust granted, a slow
  // boot) changes what the rows say about running.
  useEffect(() => onThirdPartyRendererModulesLoaded(() => void load()), [load])
  // What is installed changed under the window: an install elsewhere, or a
  // module copied into the drop-in folder while Studio runs.
  useEffect(() => (windowHasStudio() ? extensionsApi.onThirdPartyModulesChanged(() => void load()) : undefined), [load])

  const installFromFolder = useCallback(async () => {
    setInstalling(true)
    setMessage(null)
    try {
      const result = await addThirdPartyModuleFromFolder(window.api, lifecycle)
      if (result.status === 'failed') setMessage({ tone: 'error', text: result.message })
      if (result.status === 'installed') {
        // Links were left out of the copy: say which, so nothing is missing
        // without a word.
        if (result.strippedLinks.length > 0) {
          setMessage({
            tone: 'warn',
            text: `Symbolic links were left out: ${result.strippedLinks.join(', ')}. An extension ships regular files only.`,
          })
        }
        await load()
      }
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
          title: copy.settings.useThirdPartyExtensions.revokeTrustIn(module.manifest.displayName),
          body: copy.settings.useThirdPartyExtensions.theseWorkspacesStopWorkingUntil(
            affected.map((workspace) => workspace.name).join(', '),
          ),
          confirmLabel: copy.settings.useThirdPartyExtensions.revokeTrust,
          tone: 'danger',
        })
        if (!confirmed) return
      }
      setPendingId(id)
      setMessage(null)
      try {
        const result = await lifecycle.setTrust(id, false)
        if (!result.ok) setMessage({ tone: 'error', text: result.message ?? 'Couldn’t update trust.' })
        // Its window code is no longer served: what it added leaves now.
        await refreshThirdPartyRendererModules()
        await load()
      } finally {
        setPendingId(null)
      }
    },
    [confirmDialog, lifecycle, load],
  )

  const canUninstall = lifecycle !== null

  const uninstall = useCallback(
    async (module: ThirdPartyModuleView) => {
      if (!lifecycle) return
      const name = module.manifest.displayName
      const confirmed = await confirmDialog({
        title: copy.settings.useThirdPartyExtensions.uninstall(name),
        // What leaves and what stays. What the app kept for it outside any
        // project is deleted, so a module installed under the same id later
        // starts empty; work it saved inside a project is the person's and is
        // never touched — saying so is what makes the button pressable.
        body:
          'Its files are removed, with its settings, the data it stored ' +
          'outside your projects and the keys you gave it. Work it saved in your projects stays. Code already ' +
          'running stops at the next restart.',
        confirmLabel: copy.settings.useThirdPartyExtensions.uninstall2,
        tone: 'danger',
      })
      if (!confirmed) return
      setPendingId(module.manifest.id)
      setMessage(null)
      try {
        const result = await lifecycle.uninstall(module.manifest.id)
        if (result.ok) {
          // What it added leaves before its switch is forgotten, so the
          // default (on) never brings an uninstalled extension back.
          await refreshThirdPartyRendererModules()
          forgetModules(result.removedModuleIds)
          if (module.launch.mainLoaded) {
            showToast({
              tone: 'neutral',
              title: copy.settings.useThirdPartyExtensions.uninstalled(name),
              description: copy.settings.useThirdPartyExtensions.itStopsAtTheNext,
            })
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
    [confirmDialog, lifecycle, load, forgetModules],
  )

  const reveal = useCallback(async (module: ThirdPartyModuleView) => {
    if (typeof window.api.revealThirdPartyModule !== 'function') return
    const result = await window.api.revealThirdPartyModule(module.manifest.id)
    if (!result.ok) setMessage({ tone: 'error', text: result.message ?? 'Couldn’t open its folder.' })
  }, [])

  return {
    modules,
    rejected,
    loaded,
    installing,
    pendingId,
    message,
    dismissMessage: () => setMessage(null),
    installFromFolder,
    trustAndEnable,
    revokeTrust,
    uninstall: canUninstall ? uninstall : null,
    reveal: typeof window.api.revealThirdPartyModule === 'function' ? reveal : null,
    reload: load,
  }
}
