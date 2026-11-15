import { JSDOM } from 'jsdom'
import { expect, test, vi } from 'vitest'

test('debounces persistence, flushes on unmount, restores failed sends and clears acknowledged sends', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  vi.useFakeTimers()
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useComposerDraft } = await import('./useComposerDraft')
  const { composerDraftStore } = await import('./draftStore')
  let hook!: ReturnType<typeof useComposerDraft>
  function Harness() {
    hook = useComposerDraft('workspace', 'agent')
    return null
  }
  let root = createRoot(document.createElement('div'))
  try {
    await act(async () => {
      root.render(createElement(Harness))
    })
    await act(async () => {
      hook.setDraft('unfinished')
      await vi.advanceTimersByTimeAsync(399)
    })
    expect(composerDraftStore().getState().read('workspace', 'agent').text).toBe('')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(composerDraftStore().getState().read('workspace', 'agent').text).toBe('unfinished')
    await act(async () => {
      hook.setDraft('new unsaved text')
    })
    await act(async () => root.unmount())
    expect(composerDraftStore().getState().read('workspace', 'agent').text).toBe('new unsaved text')
    root = createRoot(document.createElement('div'))
    await act(async () => {
      root.render(createElement(Harness))
    })
    expect(hook.draft).toBe('new unsaved text')
    let token: symbol | null = null
    const send = (message: string, commandId = 'cmd-1') => ({
      message,
      fromDraft: true,
      commandId,
      localTurnId: `turn-${commandId}`,
      attachments: [],
      metadata: { skillIds: [], mentions: [], files: [] },
    })
    await act(async () => {
      token = hook.beginDraftSend(send(hook.draft))
    })
    expect(hook.draft).toBe('')
    // Out of the drafts before the send leaves: a reload mid-send cannot bring
    // it back as a draft. It is kept as the chat's pending send instead.
    expect(composerDraftStore().getState().read('workspace', 'agent').text).toBe('')
    const stored = () => JSON.parse(window.localStorage.getItem('sprintengine-conversation-drafts') ?? '{}')
    expect(JSON.stringify(stored().state.drafts)).not.toContain('new unsaved text')
    expect(Object.values(stored().state.sends)).toMatchObject([{ text: 'new unsaved text', commandId: 'cmd-1' }])
    await act(async () => {
      hook.finishDraftSend(token, false)
    })
    expect(hook.draft).toBe('new unsaved text')
    expect(JSON.stringify(stored().state.drafts)).toContain('new unsaved text')
    expect(stored().state.sends, 'a send answered, even refused, is no longer pending').toEqual({})
    await act(async () => {
      token = hook.beginDraftSend(send(hook.draft, 'cmd-2'))
    })
    await act(async () => {
      hook.finishDraftSend(token, true)
    })
    expect(composerDraftStore().getState().read('workspace', 'agent').text).toBe('')
    await act(async () => {
      hook.setDraft('queued')
      hook.clearDraft()
    })
    expect(hook.draft).toBe('')
    await act(async () => {
      hook.setDraft('sending')
      token = hook.beginDraftSend(send('sending', 'cmd-3'))
      hook.setDraft('newer draft')
      hook.finishDraftSend(token, true)
    })
    expect(hook.draft).toBe('newer draft')
    expect(composerDraftStore().getState().read('workspace', 'agent').text).toBe('newer draft')
  } finally {
    await act(async () => root.unmount())
    vi.useRealTimers()
    dom.window.close()
    for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
