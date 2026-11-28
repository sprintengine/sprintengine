import { afterEach, expect, test, vi } from 'vitest'

import type { Workspace } from '../../../../shared/workspace'

// A star, colour, name or Auto-settle on this window's own chat is asked of
// its Studio, and the record moves at once. A refusal puts back what the
// record held and says why, as a refused settle or snooze does.

const answers: Array<{ ok: true } | { ok: false; code: string; message: string }> = []
vi.mock('../localChatRecord', () => ({
  changeLocalChat: vi.fn(async () => answers.shift() ?? { ok: true }),
  restLocalChat: vi.fn(async () => ({ ok: true })),
}))
const toasts: Array<{ title: string; description?: string }> = []
vi.mock('../toastStore', async (original) => ({
  ...(await original<typeof import('../toastStore')>()),
  showToast: (toast: { title: string; description?: string }) => {
    toasts.push(toast)
    return 'toast'
  },
}))

const { useWorkspaceStore } = await import('../workspaceStore')

const REFUSED = { ok: false as const, code: 'stale', message: 'This chat changed since that was decided.' }

function seed(fields: Partial<Workspace> = {}): void {
  useWorkspaceStore.setState({
    workspaces: [{ id: 'chat', name: 'Router work', agents: {}, ...fields } as unknown as Workspace],
  })
}
const record = () => useWorkspaceStore.getState().workspaces[0]!
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  answers.length = 0
  toasts.length = 0
})

test('a refused star puts back the mark the chat had, and says why', async () => {
  seed({ highlight: { starred: false, color: 'blue' } })
  answers.push(REFUSED)
  useWorkspaceStore.getState().setWorkspaceHighlight('chat', { starred: true })
  expect(record().highlight).toEqual({ starred: true, color: 'blue' })
  await settle()
  expect(record().highlight).toEqual({ starred: false, color: 'blue' })
  expect(toasts).toEqual([{ tone: 'neutral', title: '“Router work” was not changed', description: REFUSED.message }])
})

test('a refused rename puts back the name and its lock; an accepted one keeps them', async () => {
  seed({ titleLocked: false })
  answers.push(REFUSED)
  useWorkspaceStore.getState().renameWorkspace('chat', 'Calendar fix')
  await settle()
  expect(record().name).toBe('Router work')
  expect(record().titleLocked).toBe(false)
  expect(toasts).toHaveLength(1)

  useWorkspaceStore.getState().renameWorkspace('chat', 'Calendar fix')
  await settle()
  expect(record().name).toBe('Calendar fix')
  expect(toasts).toHaveLength(1)
})

test('a refused Auto-settle is switched back; a field moved again since is left as it is now', async () => {
  seed({ autoSettleEnabled: null })
  answers.push(REFUSED)
  useWorkspaceStore.getState().setWorkspaceAutoSettle('chat', true)
  await settle()
  expect(record().autoSettleEnabled).toBeNull()

  // Starred, then coloured before the star was answered: the refused star
  // does not undo the colour asked after it.
  seed({ highlight: undefined })
  let refuse: (answer: typeof REFUSED) => void = () => undefined
  const { changeLocalChat } = await import('../localChatRecord')
  vi.mocked(changeLocalChat).mockImplementationOnce(() => new Promise((resolve) => (refuse = resolve)))
  useWorkspaceStore.getState().setWorkspaceHighlight('chat', { starred: true })
  useWorkspaceStore.getState().setWorkspaceHighlight('chat', { color: 'green' })
  refuse(REFUSED)
  await settle()
  expect(record().highlight).toEqual({ starred: true, color: 'green' })
})

test('a window with no Studio to ask keeps its record and says nothing', async () => {
  seed({ highlight: undefined })
  answers.push({ ok: false, code: 'unavailable', message: 'This window has no Studio to ask.' })
  useWorkspaceStore.getState().setWorkspaceHighlight('chat', { starred: true })
  await settle()
  expect(record().highlight).toEqual({ starred: true, color: null })
  expect(toasts).toEqual([])
})
