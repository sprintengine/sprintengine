import type { IpcRendererEvent } from 'electron'
import { ipc as ipcRenderer } from '../ipc-router'
import type { ElectronApi, HostedCardFeedReadInput, HostedCardFeedReadResult } from '../../shared/electron-api'

// The card feed's get, refresh and changed channels. A card's Go is the
// Studio protocol's `cards.run` (studio/agentSkills.ts).
// `onHostedCardFeedChanged` returns the unsubscribe rather than relying on the
// caller to remember the handler: the home page mounts and unmounts with the
// Extensions door, and a listener left behind on every open would push a feed
// into a component that is no longer on screen.
//
// `hostedCardFeedRefresh` has NO renderer caller today, and that is the state
// this file was left in on purpose (2026-09-06,
// backlog/2026-09-06-the-seams-that-lead-nowhere.md §1). The store's refresh
// action was removed — nothing in the app pressed it — but the binding stays,
// because `ElectronApi` declares the channel and this is where its renderer
// half lives; deleting it here would leave the contract naming a call the
// bridge does not make. The fetching that actually happens is the hourly poller
// in app-lifecycle.ts, which reaches `readHostedCardFeed` from main and comes
// back through `hosted-card-feed:changed`.
export const hostedCardFeedApi = {
  hostedCardFeedGet: (): Promise<HostedCardFeedReadResult> => ipcRenderer.invoke('hosted-card-feed:get'),
  hostedCardFeedRefresh: (input?: Pick<HostedCardFeedReadInput, 'forceRefresh'>): Promise<HostedCardFeedReadResult> =>
    ipcRenderer.invoke('hosted-card-feed:refresh', input),
  onHostedCardFeedChanged: (cb: (result: HostedCardFeedReadResult) => void): (() => void) => {
    const ch = 'hosted-card-feed:changed'
    const handler = (_: IpcRendererEvent, result: HostedCardFeedReadResult): void => cb(result)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
} satisfies Pick<ElectronApi, 'hostedCardFeedGet' | 'hostedCardFeedRefresh' | 'onHostedCardFeedChanged'>
