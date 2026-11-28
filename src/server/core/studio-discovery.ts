import type { StudioDiscovery, StudioDiscoveryAnswer } from '../rpc/studio-rpc-types'
import type { StudioWorkspaceList } from '../workspaces/studio-workspace-list'
import type { StudioWorkspaceReads } from '../workspaces/studio-workspace-reads'
import type { StudioCliRuntimes } from './studio-cli-runtimes'

// What a Studio protocol client reads before it starts a chat: this Studio's
// own list of its chats (`studio-workspace-list.ts`), the CLIs it runs
// (`studio-cli-runtimes.ts`), and a project's checkout and what a chat there
// can use (`studio-workspace-reads.ts`). Every Studio serves them from its
// own records and its own machine, with or without a desktop shell around
// it, and the gateway's tools of the same purpose (`workspace.list`,
// `cli.runtime.list`, `workspace.checkout`, `workspace.extensions`) answer
// from the same ones, so the phone and a paired desktop on the protocol read
// exactly what an agent on MCP reads.
//
// Whoever asks on the protocol is outside this Studio: a chat another
// environment holds is reached there, never read through here
// (design-wsl-ssh-direct PR 1d, decision 7). Who may ask is the protocol's
// grant check, made before this is reached.

/** A refusal whose code names something this Studio does not hold is `not_found`; any other is `unavailable`. */
function refusalOf(refusal: { code: string; message: string }): StudioDiscoveryAnswer<never> {
  return {
    ok: false,
    code: refusal.code.startsWith('unknown_') ? 'not_found' : 'unavailable',
    message: refusal.message,
  }
}

export function createStudioDiscovery(core: {
  workspaceList: StudioWorkspaceList
  cliRuntimes: StudioCliRuntimes
  workspaceReads: StudioWorkspaceReads
}): StudioDiscovery {
  const own = { ownOnly: true }
  return {
    workspaces: async () => (await core.workspaceList.list(own)).workspaces,
    async runtimes(cli) {
      const answer = await core.cliRuntimes.list(cli ?? null)
      return answer.ok ? { ok: true, value: { clis: answer.clis } } : refusalOf(answer)
    },
    async checkout(workspaceId) {
      const answer = await core.workspaceReads.checkout(workspaceId, own)
      return answer.ok ? { ok: true, value: answer.checkout } : refusalOf(answer)
    },
    async extensions(workspaceId, cli) {
      const answer = await core.workspaceReads.extensions(workspaceId, cli ?? null, own)
      return answer.ok ? { ok: true, value: answer.extensions } : refusalOf(answer)
    },
  }
}
