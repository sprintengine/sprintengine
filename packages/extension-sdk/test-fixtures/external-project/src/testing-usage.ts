// An extension's own test, compiled against the packed tarball only: the
// manifest validated by the SDK, the worker activated against the fake main
// host, and each surface mounted with the fake frame studio.

import {
  getModuleStorage,
  validateExtensionManifest,
  type ExtensionManifest,
  type ExtensionSurface,
  type ExtensionUiEntry,
  type ExtensionWorkerEntry,
} from '@sprintengine/extension-sdk'
import {
  createFakeFrameStudio,
  createFakeMainHost,
  type FakeFrameStudio,
  type FakeMainHost,
} from '@sprintengine/extension-sdk/testing'

import raw from '../extension/extension.json'
import * as door from './door'
import * as worker from './main'
import * as probe from './probe'

export function readManifest(): ExtensionManifest {
  const result = validateExtensionManifest(raw, { authoring: true })
  if (!result.ok) throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'))
  return result.manifest
}

export async function exerciseExtension(root: HTMLElement): Promise<string> {
  const manifest = readManifest()
  const workerEntry: ExtensionWorkerEntry = worker
  const main: FakeMainHost = createFakeMainHost({ manifest, storage: { global: { 'last-port': 'Galway' } } })
  await ('activate' in workerEntry ? workerEntry.activate : workerEntry.default)(main.host)
  await main.startup()
  const stored = await getModuleStorage(main.host).get({ key: 'last-port' })
  const refreshed = await main.methods.operate('forecast.refresh', { where: 'palette', workspaceId: 'ws-app' })
  const forecast = await main.tools.call('weather_deck_forecast', { city: 'Galway' })

  const frame: FakeFrameStudio = createFakeFrameStudio({ manifest, main })
  const surfaces: Array<[ExtensionUiEntry, ExtensionSurface]> = [
    [probe, { point: 'panels', id: 'probe', workspaceId: 'ws-app' }],
    [door, { point: 'doors', id: 'deck' }],
  ]
  const closers: Array<() => void> = []
  for (const [entry, surface] of surfaces) closers.push(await frame.mount(entry, surface, root))
  for (const close of closers) close()
  const studio = frame.studio({ point: 'doors', id: 'deck' })
  studio.ready()
  await studio.host.call('doors.open', { id: 'deck' })
  return [
    String(stored.ok),
    String(refreshed.ok),
    String(forecast.isError ?? false),
    frame.readied.map((surface) => `${surface.point}/${surface.id}`).join(','),
    frame.openedDoors.join(','),
    String(main.undeclared.length + frame.undeclared.length),
  ].join(' ')
}
