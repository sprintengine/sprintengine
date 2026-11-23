import React, { useCallback, useEffect, useRef, useState, type JSX } from 'react'

import type { ThirdPartyModuleView } from '../../../../shared/modules/manifest'
import { showToast } from '../../store/toastStore'
import { studioModuleSwitchStore, useWorkspaceStore } from '../../store/workspaceStore'
import { windowModuleSwitches } from '../../studio/moduleSwitches'
import { windowModuleLifecycle } from '../../studio/moduleLifecycle'
import { ApprovalReviewDialog } from './ApprovalReviewDialog'
import { ExtensionMark } from './ExtensionRow'
import { accessItems, publisherName, sourceLabel } from './extensionsModel'
import { useThirdPartyExtensions } from './useThirdPartyExtensions'

// A development folder registered from outside the window (`sprintengine-
// extension dev load`, or an agent's `extension.dev.load`) runs nothing until
// the person approves it, and only the person can: nothing over Studio's
// socket approves one. So the window asks as soon as one waits: the same
// review Settings ▸ Extensions opens, naming the folder and what it may do.
// Closing it leaves the folder waiting, approvable in Settings; it is asked
// again when what it asks for changes. Only a window whose Studio is this
// machine's asks, as only its person may approve.

/** One question per folder and what it asks for: a save that asks for more asks again. */
const questionKey = (module: ThirdPartyModuleView) =>
  `${module.development?.folder ?? ''}\n${module.approval.state === 'pending' ? module.approval.fingerprint : ''}`

function useSwitchOn(): (moduleId: string, enabled: boolean) => void {
  const setModuleEnabled = useWorkspaceStore((state) => state.setModuleEnabled)
  const [switches] = useState(() => windowModuleSwitches(studioModuleSwitchStore))
  return useCallback(
    (moduleId: string, enabled: boolean) => {
      if (switches) void switches.switchModule(moduleId, enabled)
      else setModuleEnabled(moduleId, enabled)
    },
    [setModuleEnabled, switches],
  )
}

export function DevFolderApprovalHost(): JSX.Element | null {
  const [ownStudio] = useState(() => windowModuleLifecycle() !== null)
  if (!ownStudio) return null
  return <DevFolderApprovalQuestion />
}

function DevFolderApprovalQuestion(): JSX.Element | null {
  const extensions = useThirdPartyExtensions(useSwitchOn())
  const dismissed = useRef(new Set<string>())
  const [, setDismissals] = useState(0)
  const asking =
    extensions.modules.find(
      (module) =>
        module.development !== undefined &&
        module.approval.state === 'pending' &&
        !dismissed.current.has(questionKey(module)),
    ) ?? null
  const [approving, setApproving] = useState(false)
  useEffect(() => setApproving(false), [asking?.development?.folder])
  if (!asking) return null
  const access = accessItems(asking.manifest.permissions)
  return (
    <ApprovalReviewDialog
      module={asking}
      icon={<ExtensionMark module={asking} doorIcon={null} size={40} />}
      meta={[publisherName(asking.manifest), sourceLabel(asking), `v${asking.manifest.version}`]
        .filter(Boolean)
        .join(' · ')}
      care={access.care}
      standard={access.standard}
      busy={approving}
      onCancel={() => {
        dismissed.current.add(questionKey(asking))
        setDismissals((count) => count + 1)
      }}
      onApprove={() => {
        setApproving(true)
        void extensions.approveAndEnable(asking).then((ok) => {
          setApproving(false)
          if (!ok) {
            showToast({
              tone: 'error',
              title: `Couldn’t approve ${asking.manifest.displayName}. Review it in Settings > Extensions.`,
            })
            dismissed.current.add(questionKey(asking))
            setDismissals((count) => count + 1)
          }
        })
      }}
    />
  )
}
