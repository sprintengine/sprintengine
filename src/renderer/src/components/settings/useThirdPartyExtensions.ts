import { useCallback, useEffect, useState } from 'react'

import { errorMessage } from '../../../../shared/errors'
import type { ModuleManifestIssue, ThirdPartyModuleView } from '../../../../shared/modules/manifest'
import { onThirdPartyRendererModulesLoaded, refreshThirdPartyRendererModules } from '../../modules'
import { showToast } from '../../store/toastStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import type { ActionResult } from '../ui'
import { windowModuleLifecycle } from '../../studio/moduleLifecycle'
import type { StudioExtensionInstallSource } from '../../../../../packages/studio-protocol/src/public'
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
  const [justInstalled, setJustInstalled] = useState<string | null>(null)
  const clearJustInstalled = useCallback(() => setJustInstalled(null), [])
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

  const installFromFolder = useCallback(
    async (as: 'install' | 'development' = 'install') => {
      setInstalling(true)
      setMessage(null)
      try {
        const result = await addThirdPartyModuleFromFolder(window.api, lifecycle, as)
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
          // A development folder that waits is asked about by the window
          // itself (DevFolderApprovalHost), wherever it was registered from.
          if (result.approval?.state === 'pending' && result.id) {
            if (as !== 'development') setAwaitingReview(result.id)
          }
          // One that asks nothing still shows what it added, its skills and
          // hosted MCP servers among it: the install's own review.
          else if (result.id) setJustInstalled(result.id)
        }
      } finally {
        setInstalling(false)
      }
    },
    [lifecycle, load],
  )

  // An install the catalogue made (from an entry, a git URL, or an update):
  // it waits for review, or shows what it added, as a folder install does.
  const afterInstall = useCallback(
    async (
      result:
        | { ok: true; moduleId: string; approval: { state: string }; strippedLinks: string[]; leftOut?: string[] }
        | { ok: false; message: string },
    ): Promise<boolean> => {
      if (!result.ok) {
        setMessage({ tone: 'error', text: result.message })
        return false
      }
      const notes = [
        ...(result.strippedLinks.length > 0
          ? [`Symbolic links were left out: ${result.strippedLinks.join(', ')}.`]
          : []),
        ...(result.leftOut && result.leftOut.length > 0
          ? [
              `Studio does not install a Claude Code plugin’s ${result.leftOut.join(', ')}; its skills and MCP servers are installed.`,
            ]
          : []),
      ]
      if (notes.length > 0) setMessage({ tone: 'warn', text: notes.join(' ') })
      await refreshThirdPartyRendererModules()
      await load()
      if (result.approval.state === 'pending') setAwaitingReview(result.moduleId)
      else setJustInstalled(result.moduleId)
      return true
    },
    [load],
  )

  const installFrom = useCallback(
    async (from: StudioExtensionInstallSource): Promise<boolean> => {
      if (!lifecycle) return false
      setInstalling(true)
      setMessage(null)
      try {
        return await afterInstall(await lifecycle.installFrom(from))
      } catch (error) {
        setMessage({ tone: 'error', text: errorMessage(error, 'Couldn’t install it.') })
        return false
      } finally {
        setInstalling(false)
      }
    },
    [afterInstall, lifecycle],
  )

  const update = useCallback(
    async (module: ThirdPartyModuleView) => {
      if (!lifecycle) return
      setPendingId(module.manifest.id)
      setMessage(null)
      try {
        await afterInstall(await lifecycle.update(module.manifest.id))
      } finally {
        setPendingId(null)
      }
    },
    [afterInstall, lifecycle],
  )

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
      // A development folder is only taken out: its files are the author's, and stay.
      if (module.development) {
        setPendingId(module.manifest.id)
        setMessage(null)
        try {
          const result = await lifecycle.devUnload(module.development.folder)
          if (!result.ok) setMessage({ tone: 'error', text: result.message || `Couldn’t remove ${name}.` })
          await refreshThirdPartyRendererModules()
          await load()
        } finally {
          setPendingId(null)
        }
        return
      }
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
          // Only an extension with a worker had one to stop.
          if (module.launch.hasMainEntry && module.launch.mainLoaded) {
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
    justInstalled,
    clearJustInstalled,
    uninstall: canUninstall ? uninstall : null,
    installFrom: lifecycle ? installFrom : null,
    update: lifecycle ? update : null,
    reveal: typeof window.api.revealThirdPartyModule === 'function' ? reveal : null,
    reload: load,
  }
}
