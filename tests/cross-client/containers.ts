import type { StudioClient } from '../../packages/client-runtime/src/public'
import type { ContainersApi } from '../../src/renderer/src/studio/containers'
import type { GateClient } from './client'
import type { Matrix } from './matrix'

// Chats' containers on the protocol (`containers.*`): the desktop window's own
// code (`src/renderer/src/studio/containers.ts`, what New chat and Settings ▸
// Machines call) makes one on this computer, sees it listed and the change
// told, pushes its branch out and removes it, and keeps Claude Code's token;
// main's `ContainerChats` is stood in by the server host (no Docker). The
// phone and the paired desktop, on their own connections to the desktop they
// paired with, are offered the capability's name and refused every method and
// the stream in words: a container's chat runs on a machine of its own, which
// no device reaches through this desktop, so neither is offered the making.

const LOCAL = { kind: 'local' } as const

async function refusal(asked: Promise<unknown>): Promise<{ code: string; message: string } | null> {
  try {
    await asked
    return null
  } catch (error) {
    // By its code, not its class: the phone's bundle carries its own copy of the runtime.
    const code = (error as { code?: unknown } | null)?.code
    return {
      code: typeof code === 'string' ? code : 'thrown',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Every method a device could try, with params the protocol accepts, so only the grant refuses it. */
const ASKS = (folder: string): Array<[string, Record<string, unknown>]> => [
  ['containers.status', { host: LOCAL }],
  ['containers.list', {}],
  ['containers.create', { commandId: 'device-create', host: LOCAL, folder, label: 'from a device' }],
  ['containers.push', { commandId: 'device-push', id: '0000000000000001' }],
  ['containers.remove', { commandId: 'device-remove', id: '0000000000000001' }],
  ['containers.startDocker', { commandId: 'device-start', host: LOCAL }],
  ['containers.tokenStatus', {}],
  ['containers.setToken', { commandId: 'device-token', token: 'sk-ant-oat01-device' }],
  ['containers.clearToken', { commandId: 'device-clear' }],
]

export async function runContainerLeg(input: {
  matrix: Matrix
  desktop: GateClient & { containers: ContainersApi }
  devices: GateClient[]
  /** The project folder on the desktop the container copies. */
  folder: string
}): Promise<void> {
  const { matrix, desktop, devices, folder } = input
  let made: string | null = null

  await matrix.run('desktop', 'container', async () => {
    const api = desktop.containers
    const status = await api.containerDockerStatus(LOCAL)
    if (status.state !== 'ready') throw new Error(`desktop: Docker said ${status.state}: ${status.words}`)
    let changes = 0
    const stop = api.onContainersChanged(() => void changes++)
    try {
      // The follow is live once its first read lands: a change before it would be lost.
      await new Promise((resolve) => setTimeout(resolve, 300))
      const before = changes
      const created = await api.containerCreate({
        host: LOCAL,
        folder,
        label: 'gate container',
        image: { kind: 'studio-default' },
      })
      if (!created.ok) throw new Error(`desktop: no container: ${created.message}`)
      made = created.id
      for (let tries = 0; changes === before && tries < 100; tries++)
        await new Promise((resolve) => setTimeout(resolve, 50))
      if (changes === before) throw new Error('desktop: the window was not told a container was made')
      const listed = await api.containersList()
      const row = listed.find((container) => container.id === created.id)
      if (!row) throw new Error('desktop: the container it made is not listed')
      if (row.repo?.source !== folder) throw new Error('desktop: the list does not say which folder it copied')
      const pushed = await api.containerPush(created.id)
      if (!pushed.ok) throw new Error(`desktop: its branch was not pushed: ${pushed.message}`)
      // Claude Code's token for containers: kept, read back as set (never its words), forgotten.
      if (!(await api.containerTokenSet('sk-ant-oat01-gate')).ok) throw new Error('desktop: the token was not kept')
      if (!(await api.containerTokenStatus()).set) throw new Error('desktop: the token does not read as set')
      if (!(await api.containerTokenClear()).ok) throw new Error('desktop: the token was not forgotten')
    } finally {
      stop()
    }
  })

  for (const device of devices) {
    await matrix.run(device.id, 'container', async () => {
      const reach = device.device
      if (!reach) throw new Error(`${device.id} has no reach of its own to check`)
      const wrong: string[] = []
      await reach.ask(async (client: StudioClient) => {
        // Told the desktop makes containers, so it can say who does, in words of its own.
        if (!(client.welcome.capabilities as readonly string[]).includes('containers'))
          wrong.push('the desktop’s containers capability was not advertised')
        for (const [method, params] of ASKS(folder)) {
          const refused = await refusal(client.request(method as never, params as never))
          if (!refused) wrong.push(`${method} was answered`)
          else if (refused.code !== 'owner_required') wrong.push(`${method} was refused as ${refused.code}`)
          else if (!/own connections|own desktop windows/u.test(refused.message))
            wrong.push(`${method} was refused without words: "${refused.message}"`)
        }
        let stop: () => void = () => undefined
        const stream = await refusal(
          new Promise((resolve, reject) => {
            stop = client.subscribe(
              'containers.changed',
              {},
              { onPayload: resolve, onEnd: (error) => reject(error ?? new Error('ended')) },
            )
            setTimeout(() => resolve('followed'), 5_000)
          }),
        )
        stop()
        if (stream?.code !== 'owner_required')
          wrong.push(`the containers.changed stream was ${stream?.code ?? 'followed'}`)
      })
      if (wrong.length) throw new Error(`${device.id}: ${wrong.join('; ')}`)
    })
  }

  // The desktop's container goes, so nothing the devices did not see is left behind.
  if (made) {
    const removed = await desktop.containers.containerRemove({ id: made })
    if (!removed.ok) throw new Error(`desktop: its container was not removed: ${removed.message}`)
  }
}
