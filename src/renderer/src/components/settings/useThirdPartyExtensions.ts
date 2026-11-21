import { useCallback, useEffect, useState } from 'react'

import { errorMessage } from '../../../../shared/errors'
import type { ModuleManifestIssue, ThirdPartyModuleView } from '../../../../shared/modules/manifest'
import { onThirdPartyRendererModulesLoaded, refreshThirdPartyRendererModules } from '../../modules'
import { showToast } from '../../store/toastStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import type { ActionResult } from '../ui'
import { windowModuleLifecycle } from '../../studio/moduleLifecycle'
import { addThirdPartyModuleFromFolder } from './addThirdPartyModuleFromFolder'
import { extensionsApi, windowHasStudio } from '../../studio/extensions'
import { copy } from '../../../../shared/copy'

// Settings → Extensions, the third-party half. It lists what is installed,
// and installs, approves and uninstalls through the window's Studio
// (`extension.*`), which owns what runs there. The page and its rows only
// render what this hands them.

export function useThirdPartyExtensions(onSetEnabled: (moduleId: string, enabled: boolean) => void) {
  const [modules, setModules] = useState<ThirdPartyModuleView[]>([])
  const [rejected, setRejected] = useState<Array<{ path: string; issues: ModuleManifestIssue[] }>>([])
  const [loaded, setLoaded] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [message, setMessage] = useState<ActionResult | null>(null)
  // An install that waits for approval: the page opens its review once listed,
  // so installing asks once, there and then.
  const [awaitingReview, setAwaitingReview] = useState<string | null>(null)
  const clearAwaitingReview = useCallback(() => setAwaitingReview(null), [])
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
  // A renderer batch that landed after the first list (an approval, a slow
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
        if (result.approval?.state === 'pending' && result.id) setAwaitingReview(result.id)
      }
    } finally {
      setInstalling(false)
    }
  }, [lifecycle, load])

  // Approve and turn on, in one step: the review is the consent, and an
  // approved extension left off would make the person find a second switch
  // for the same decision. The approval is written first and on its own, so a
  // refused one never turns anything on. It names the fingerprint the review
  // showed: an extension that changed since is refused, not approved unseen.
  const approveAndEnable = useCallback(
    async (module: ThirdPartyModuleView): Promise<boolean> => {
      if (!lifecycle || module.approval.state !== 'pending') return false
      const id = module.manifest.id
      setPendingId(id)
      setMessage(null)
      try {
        const result = await lifecycle.approve(id, module.approval.fingerprint)
        if (!result.ok) {
          setMessage({ tone: 'error', text: result.message || `Couldn’t approve ${module.manifest.displayName}.` })
          await load()
          return false
        }
        onSetEnabled(id, true)
        await refreshThirdPartyRendererModules()
        await load()
        return true
      } catch (error) {
        setMessage({ tone: 'error', text: errorMessage(error, 'Couldn’t approve it.') })
        return false
      } finally {
        setPendingId(null)
      }
    },
    [lifecycle, load, onSetEnabled],
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
          'outside your projects and the keys you gave it. Work it saved in your projects stays. Its worker, ' +
          'if it is running, stops now.',
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
              description: copy.settings.useThirdPartyExtensions.itsWorkerStopped,
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
    approveAndEnable,
    awaitingReview,
    clearAwaitingReview,
    uninstall: canUninstall ? uninstall : null,
    reveal: typeof window.api.revealThirdPartyModule === 'function' ? reveal : null,
    reload: load,
  }
}
