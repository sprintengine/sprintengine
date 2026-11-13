import type * as ChatStores from './chatStores'

// A stand-in for what the window's Studio keeps beside its chats
// (`chatStores.ts`), for tests of what calls it. A test mocks the module with
// this one:
//
//   vi.mock('../../studio/chatStores', () => import('../../studio/chatStores.double'))
//
// and sets what it needs on `chatStoresDouble`: each call goes to the member
// of the same name there, as it stands when the call is made. Unset, a call
// answers as a Studio with nothing kept would. `chatStoresReachable = false`
// has `windowChatStores` say this page reaches no Studio.

type Api = ChatStores.ChatStoresApi

function blank(): Api {
  return {
    usageLimits: async () => ({ snapshots: [] }),
    onUsageLimitsChanged: () => () => undefined,
    usageLimitResumes: async () => ({ autoResume: false, notices: [] }),
    updateUsageLimitResume: async () => ({ autoResume: false, notices: [] }),
    onUsageLimitResumesChanged: () => () => undefined,
    usageReport: async () => ({ ok: false, message: 'No usage here.' }),
    scanImportableConversations: async () => ({ ok: true, folders: [], sources: [] }),
    importConversations: async () => ({ ok: true, imported: [], skipped: 0, failed: [] }),
  }
}

export const chatStoresDouble: Api = blank()

export const chatStoresDoubleState = { reachable: true }

/** Put every member back as it was. */
export function resetChatStoresDouble(): void {
  Object.assign(chatStoresDouble, blank())
  chatStoresDoubleState.reachable = true
}

export const chatStoresApi: Api = new Proxy({} as Api, {
  get: (_target, member: keyof Api) => chatStoresDouble[member],
})

export function windowChatStores(): Api | null {
  return chatStoresDoubleState.reachable ? chatStoresApi : null
}
