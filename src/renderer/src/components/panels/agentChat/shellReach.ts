import { useSyncExternalStore } from 'react'

import { clientSupports } from '../../../clientCapabilities'
import {
  watchWindowStudioWelcome,
  windowShellEnvironmentId,
  windowStudioWelcome,
} from '../../../studio/windowStudioClient'
import { useConversationTransport } from './conversationTransport'

// What this window and its shell reach of a chat's disk: the one place the
// chat view asks where a chat runs. A chat names its environment
// (`transport.environmentId`); the window reaches the files of the
// environment its own Studio is (its services read them over the protocol),
// and the shell the disk of the environment it started. Nothing else in the
// chat view asks whether a chat is here or elsewhere.

export type ShellReach = {
  /**
   * The window's own Studio is the chat's: a path in the transcript is read,
   * opened in a pane and linked through the window's services.
   */
  openDocument: boolean
  /** The chat runs on the shell's own disk: its paths are this computer's. */
  sameDisk: boolean
  /** …and the shell hands files about by their paths (cards to drag, attach by path). */
  dragPaths: boolean
  /** …and the shell shows a file in its folder (Finder, Explorer). */
  revealInFolder: boolean
}

const windowApi = (): object | null =>
  typeof window === 'undefined' ? null : ((window.api as object | undefined) ?? null)
const watchWelcome = (listener: () => void) => {
  const api = windowApi()
  return api ? watchWindowStudioWelcome(api, listener) : () => undefined
}
const readWelcome = () => {
  const api = windowApi()
  return api ? windowStudioWelcome(api) : null
}

/** What this window and its shell reach of an environment's disk. */
export function shellReachOf(environmentId: string | null, api: object | null = windowApi()): ShellReach {
  const windowEnvironment = api ? (windowStudioWelcome(api)?.environment.id ?? null) : null
  const shellEnvironment = api ? windowShellEnvironmentId(api) : null
  const openDocument = environmentId !== null && environmentId === windowEnvironment
  const sameDisk = environmentId !== null && environmentId === shellEnvironment
  return {
    openDocument,
    sameDisk,
    dragPaths: sameDisk && clientSupports('drag-paths'),
    revealInFolder: sameDisk && clientSupports('reveal-in-folder'),
  }
}

/** What this window and its shell reach of the chat's disk; drawn again when the window's Studio welcomes it. */
export function useShellReach(): ShellReach {
  const transport = useConversationTransport()
  useSyncExternalStore(watchWelcome, readWelcome, readWelcome)
  return shellReachOf(transport.environmentId)
}
