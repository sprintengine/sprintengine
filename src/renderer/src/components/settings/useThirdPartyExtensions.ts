import { useCallback, useEffect, useState } from 'react'

import { errorMessage } from '../../../../shared/errors'
import type { ModuleManifestIssue, ThirdPartyModuleView } from '../../../../shared/modules/manifest'
import { onThirdPartyRendererModulesLoaded, refreshThirdPartyRendererModules } from '../../modules'
import { showToast } from '../../store/toastStore'
import { studioModuleSwitchStore, useWorkspaceStore } from '../../store/workspaceStore'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import type { ActionResult } from '../ui'
import { windowCatalogueLifecycle, windowModuleLifecycle } from '../../studio/moduleLifecycle'
import { windowModuleSwitches } from '../../studio/moduleSwitches'
import type { StudioExtensionInstallSource } from '../../../../../packages/studio-protocol/src/public'
import { addThirdPartyModuleFromFolder } from './addThirdPartyModuleFromFolder'
import { forgetExtensionReplacementSwitch } from '../../modules/extension-replacements'
import { extensionsApi, windowHasStudio } from '../../studio/extensions'
import { copy } from '../../../../shared/copy'

// Settings → Extensions, the third-party half. It lists what is installed,
// and installs, approves, switches and uninstalls through the window's Studio
// (`extension.*`), which owns what runs there: from any window whose Studio
// lets its owner do it, a browser tab included. Only what picks a folder on
// this window's disk (a folder install, a development folder) stays with a
// window on the Studio's own machine. The page and its rows only render what
// this hands them.

/** How an install from a catalogue or a git URL ended; a marketplace's refusal names its plugin folders. */
export type InstallOutcome = { ok: true } | { ok: false; message: string; folders?: string[] }

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
  // Installing from a catalogue or a git URL, approving, switching and
  // uninstalling name nothing on this window's disk, so any window whose
  // Studio lets its owner do it may (a browser tab too).
  const [catalogueLifecycle] = useState(() => windowCatalogueLifecycle())
  // The window's switches, where they reach its Studio, keep the window's
  // copy in step with it; a browser tab has none.
  const [switches] = useState(() => windowModuleSwitches(studioModuleSwitchStore))

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
    ): Promise<InstallOutcome> => {
      if (!result.ok) {
        setMessage({ tone: 'error', text: result.message })
        return {
          ok: false,
          message: result.message,
          ...('folders' in result ? { folders: result.folders as string[] } : {}),
        }
      }
      const notes = [
        ...(result.strippedLinks.length > 0
          ? [`Symbolic links were left out: ${result.strippedLinks.join(', ')}.`]
          : []),
        ...(result.leftOut && result.leftOut.length > 0
          ? [
              `Studio installed the Claude Code plugin’s skills and MCP servers. Left out: ${result.leftOut.join('; ')}.`,
            ]
          : []),
      ]
      if (notes.length > 0) setMessage({ tone: 'warn', text: notes.join(' ') })
      await refreshThirdPartyRendererModules()
      await load()
      if (result.approval.state === 'pending') setAwaitingReview(result.moduleId)
      else setJustInstalled(result.moduleId)
      return { ok: true }
    },
    [load],
  )

  const installFrom = useCallback(
    async (from: StudioExtensionInstallSource): Promise<InstallOutcome> => {
      if (!catalogueLifecycle) return { ok: false, message: 'This window cannot install on its Studio.' }
      setInstalling(true)
      setMessage(null)
      try {
        return await afterInstall(await catalogueLifecycle.installFrom(from))
      } catch (error) {
        const text = errorMessage(error, 'Couldn’t install it.')
        setMessage({ tone: 'error', text })
        return { ok: false, message: text }
      } finally {
        setInstalling(false)
      }
    },
    [afterInstall, catalogueLifecycle],
  )

  // "Review version X" and "Update to X": exactly the version the person was
  // shown; a catalogue that lists another now is refused, and the row reloads.
  const update = useCallback(
    async (module: ThirdPartyModuleView, version = module.update?.version) => {
      if (!catalogueLifecycle) return
      setPendingId(module.manifest.id)
      setMessage(null)
      try {
        const outcome = await afterInstall(await catalogueLifecycle.update(module.manifest.id, version))
        if (!outcome.ok) await load()
      } finally {
        setPendingId(null)
      }
    },
    [afterInstall, catalogueLifecycle, load],
  )

  // Switch an installed extension on or off on the Studio, then in the
  // window's copy (which decides the window halves that load): through the
  // window's switches where it has them, else through the owner's lifecycle.
  // A browser tab switching only its own copy would leave the Studio's as it was.
  const setEnabled = useCallback(
    async (moduleId: string, enabled: boolean): Promise<boolean> => {
      if (switches || !catalogueLifecycle) {
        onSetEnabled(moduleId, enabled)
        return true
      }
      const result = await catalogueLifecycle.setEnabled(moduleId, enabled)
      if (!result.ok) {
        setMessage({ tone: 'error', text: result.message || 'Couldn’t switch it.' })
        await load()
        return false
      }
      onSetEnabled(moduleId, enabled)
      await refreshThirdPartyRendererModules()
      await load()
      return true
    },
    [catalogueLifecycle, load, onSetEnabled, switches],
  )

  // Approve and turn on, in one step: the review is the consent, and an
  // approved extension left off would make the person find a second switch
  // for the same decision. The approval is written first and on its own, so a
  // refused one never turns anything on. It names the fingerprint the review
  // showed: an extension that changed since is refused, not approved unseen.
  const approveAndEnable = useCallback(
    async (module: ThirdPartyModuleView): Promise<boolean> => {
      if (!catalogueLifecycle || module.approval.state !== 'pending') return false
      const id = module.manifest.id
      setPendingId(id)
      setMessage(null)
      try {
        // An install from a browser tab is approved there too: approving names nothing on a disk.
        const result = await catalogueLifecycle.approve(id, module.approval.fingerprint)
        if (!result.ok) {
          setMessage({ tone: 'error', text: result.message || `Couldn’t approve ${module.manifest.displayName}.` })
          await load()
          return false
        }
        if (!(await setEnabled(id, true))) return false
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
    [catalogueLifecycle, load, setEnabled],
  )

  const uninstall = useCallback(
    async (module: ThirdPartyModuleView) => {
      if (!catalogueLifecycle) return
      const name = module.manifest.displayName
      // A development folder is only taken out: its files are the author's, and
      // stay. It names a folder on the Studio's disk, so a window there does it.
      if (module.development) {
        if (!lifecycle) {
          setMessage({
            tone: 'error',
            text: `${name} is a development folder. Remove it from a window on the Studio’s own machine.`,
          })
          return
        }
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
        const result = await catalogueLifecycle.uninstall(module.manifest.id)
        if (result.ok) {
          // What it added leaves before its switch is forgotten, so the
          // default (on) never brings an uninstalled extension back.
          await refreshThirdPartyRendererModules()
          forgetModules(result.removedModuleIds)
          // Its takeover switch, kept in this window's storage, goes with it.
          for (const key of result.removedModuleIds) forgetExtensionReplacementSwitch(key)
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
    [catalogueLifecycle, confirmDialog, lifecycle, load, forgetModules],
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
    // A folder picked here is on the Studio's disk only in a window on its machine.
    installFromFolder: lifecycle ? installFromFolder : null,
    approveAndEnable,
    awaitingReview,
    clearAwaitingReview,
    justInstalled,
    clearJustInstalled,
    setEnabled: (moduleId: string, enabled: boolean) => void setEnabled(moduleId, enabled),
    uninstall: catalogueLifecycle ? uninstall : null,
    installFrom: catalogueLifecycle ? installFrom : null,
    update: catalogueLifecycle ? update : null,
    reveal: typeof window.api.revealThirdPartyModule === 'function' ? reveal : null,
    reload: load,
  }
}
