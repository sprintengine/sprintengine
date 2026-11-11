import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { formatEnvironmentRoute } from '../../../packages/studio-protocol/src/environment'
import {
  emptyExecutionHostSettings,
  wslHostId,
  type ExecutionHostId,
  type ExecutionHostSettings,
} from '../../shared/execution-host'
import { readStudioEnvironmentId } from '../../server/environment/environment-id'
import { createDesktopEnvironments } from './desktop-environments'

const MINI = '3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a'
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A list its owner changes, announcing each change as the real owners do. */
function owned<T>(initial: T[]) {
  let items = initial
  const listeners = new Set<() => void>()
  return {
    list: () => items,
    onChanged: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next: T[]) {
      items = next
      for (const listener of listeners) listener()
    },
  }
}

test("the desktop's registry follows each owner: settings, SSH machines and paired desktops", () => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-environments-'))
  directories.push(dir)
  let hosts: Partial<Record<ExecutionHostId, ExecutionHostSettings>> = {}
  const hostListeners = new Set<() => void>()
  const ssh = owned<{ id: string; label: string; destination: string; resolved: null; environmentId: string | null }>([
    { id: 'm_box', label: 'build-box', destination: 'dev@build-box', resolved: null, environmentId: null },
  ])
  const mesh = owned<{ id: string; machineName: string; environmentId?: string }>([])
  const environments = createDesktopEnvironments({
    userDataDir: dir,
    platform: 'win32',
    hosts: {
      get: () => hosts,
      onChanged: (listener) => {
        hostListeners.add(listener)
        return () => hostListeners.delete(listener)
      },
    },
    ssh,
    mesh,
  })
  const routes = () => environments.list().map((entry) => entry.routes.map(formatEnvironmentRoute).join(' '))
  // This machine goes by its data directory's id, the one its server says in its welcome.
  assert.equal(environments.list()[0]?.environmentId, readStudioEnvironmentId(dir))
  assert.deepEqual(routes(), ['local', 'ssh:m_box'])

  hosts = { [wslHostId('Ubuntu')]: { ...emptyExecutionHostSettings(), enabled: true } }
  for (const listener of hostListeners) listener()
  mesh.set([{ id: 'tnc_1', machineName: 'mac-mini', environmentId: MINI }])
  assert.deepEqual(routes(), ['local', 'wsl:Ubuntu', 'tailnet:tnc_1', 'ssh:m_box'])

  // The SSH machine turns out to be the paired desktop.
  ssh.set([{ id: 'm_box', label: 'build-box', destination: 'dev@build-box', resolved: null, environmentId: MINI }])
  assert.deepEqual(routes(), ['local', 'wsl:Ubuntu', 'tailnet:tnc_1 ssh:m_box'])
})
