import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'

import { useToastStore } from '../../store/toastStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  ENVIRONMENT_RECORD_LATE_MS,
  ENVIRONMENT_RECORD_WAIT_MS,
  openEnvironmentChatWhenListed,
} from './environmentChatOpening'

// A chat New chat started on an SSH machine is this desktop's to list once its
// copy of the machine's records holds it: opened when it is, however late, and
// said when it never is — never a "started" that opens nothing.

const base = useWorkspaceStore.getState().workspaces
const list = (ids: string[]) =>
  useWorkspaceStore.setState({ workspaces: [...base, ...ids.map((id) => ({ ...base[0], id }) as never)] })

afterEach(() => {
  vi.useRealTimers()
  useWorkspaceStore.setState({ workspaces: base })
  useToastStore.setState({ toasts: [] })
})

function rig() {
  const opened: string[] = []
  const said: string[] = []
  let closed = 0
  return {
    opened,
    said,
    closed: () => closed,
    input: {
      chatId: 'w-new',
      toastId: 'environment-chat:ssh:m1:w-new',
      title: 'Fix the login',
      machineName: 'build-box',
      openHere: () => {
        if (!useWorkspaceStore.getState().workspaces.some((workspace) => workspace.id === 'w-new')) return false
        opened.push('w-new')
        return true
      },
      closePanel: () => {
        closed += 1
      },
      started: () => said.push('started'),
    },
  }
}

const toast = () => useToastStore.getState().toasts.find((entry) => entry.id === 'environment-chat:ssh:m1:w-new')

test('a chat listed at once opens, and says it started', async () => {
  const { input, opened, said, closed } = rig()
  list(['w-new'])
  await openEnvironmentChatWhenListed(input)
  assert.deepEqual([opened, said, closed()], [['w-new'], ['started'], 1])
  assert.equal(toast(), undefined)
})

test('a chat listed late opens when it arrives, and its toast offered to open it meanwhile', async () => {
  vi.useFakeTimers()
  const { input, opened, closed } = rig()
  const done = openEnvironmentChatWhenListed(input)
  await vi.advanceTimersByTimeAsync(ENVIRONMENT_RECORD_WAIT_MS + 1)
  assert.equal(closed(), 1, 'New chat closes')
  assert.equal(opened.length, 0)
  assert.match(toast()?.description ?? '', /opens here once/u, 'the toast says it opens once listed')
  assert.equal(toast()?.actions?.[0]?.label, 'Open')
  // Open before it is listed opens nothing and keeps the toast.
  toast()!.actions![0]!.run()
  assert.equal(opened.length, 0)
  assert.ok(toast())
  list(['w-new'])
  await done
  assert.deepEqual(opened, ['w-new'], 'opened the moment it is listed')
  assert.equal(toast(), undefined, 'and the toast goes')
})

test('a chat never listed is said, with Open to try again', async () => {
  vi.useFakeTimers()
  const { input, opened } = rig()
  const done = openEnvironmentChatWhenListed(input)
  await vi.advanceTimersByTimeAsync(ENVIRONMENT_RECORD_WAIT_MS + ENVIRONMENT_RECORD_LATE_MS + 2)
  await done
  assert.equal(toast()?.tone, 'warn')
  assert.match(toast()?.title ?? '', /not listed here yet/u)
  list(['w-new'])
  toast()!.actions![0]!.run()
  assert.deepEqual(opened, ['w-new'], 'Open opens it once it is listed')
  assert.equal(toast(), undefined)
})

test('a toast dismissed meanwhile leaves the chat in the sidebar, unopened', async () => {
  vi.useFakeTimers()
  const { input, opened } = rig()
  const done = openEnvironmentChatWhenListed(input)
  await vi.advanceTimersByTimeAsync(ENVIRONMENT_RECORD_WAIT_MS + 1)
  useToastStore.getState().dismissToast('environment-chat:ssh:m1:w-new')
  list(['w-new'])
  await done
  assert.deepEqual(opened, [], 'not opened over what the person moved on to')
})
