import { hostname } from 'node:os'

import { app, ipcMain, MessageChannelMain, net, powerMonitor, session } from 'electron'

import { writeDiagnosticLog } from '../../diagnostics-service'
import { allowMachinePartitions } from '../../browser/guest-policy'
import { registerSshEnvironmentsIpc } from '../../ipc/ssh-environments-ipc'
import { ContainerChats } from '../container/container-chats'
import { ContainerCommandReceipts } from '../container/container-command-receipts'
import {
  createContainersDomain,
  serveContainersToServer,
  type DesktopContainersDomain,
} from '../container/containers-domain'
import { readAgentImage } from '../container/container-image'
import { ContainerAgentToken, CLAUDE_TOKEN_ENV } from '../container/container-agent-token'
import { studioPlatform } from '../../../server/platform/platform'
import { join } from 'node:path'
import { channelForVersion } from '../../update-channel-store'
import { readStudioEnv } from '../../../shared/studio-env'
import type { WorkspaceEnvironmentRef } from '../../../shared/workspace'
import type { ShellServerLink } from '../../server-supervisor/remote-core'
import { splicePort } from '../../../server/ipc/port-duplex'
import { SERVER_EVENTS, SHELL_METHODS } from '../../../server/desktop/server-methods'
import { PanePartitions } from './pane-partitions'
import { SshEnvironments } from './ssh-environments'
import { broadcastToAllWindows } from '../../window-broadcast'
import { prefixedId } from '../../../shared/random-id'

// The desktop's SSH machines (phase 8), composed in main: the saved machines
// and their sessions, their IPC, the pane's partitions behind their forwards,
// the proxy credential answered through Electron's `login` event, and the
// wake and network hooks that restart a dead session at once. Built only
// when the SSH machines preview is on (shared/ssh-preview.ts).

export type DesktopSsh = {
  environments: SshEnvironments
  panes: PanePartitions
  containers: ContainerChats
  /** The same containers as the desktop's Studio serves them to its clients (`containers.*`). */
  containersDomain: DesktopContainersDomain
}

export function createDesktopSsh(deps: {
  version: string
  /** The desktop's server, when it runs as a process of its own: its chats on SSH machines go through ports. */
  server?: ShellServerLink | null
  /** The SSH machine a workspace is on, from main's registry. */
  workspaceEnvironment(workspaceId: string): WorkspaceEnvironmentRef | null
}): DesktopSsh {
  // Claude Code's login for chats in containers, sealed with the app's keychain
  // cipher, read once the app is ready and handed only to containers on this computer.
  const containerToken = new ContainerAgentToken({
    path: join(app.getPath('userData'), 'container-claude-token'),
    cipher: {
      available: () => studioPlatform().secrets.available(),
      seal: (plaintext) => studioPlatform().secrets.seal(plaintext),
      open: (sealed) => studioPlatform().secrets.open(sealed),
    },
  })
  void app.whenReady().then(() => containerToken.value())
  const sshEnvironments = new SshEnvironments({
    containerEnvReady: () => containerToken.value().then(() => undefined),
    containerEnv: (): Record<string, string> => {
      const token = containerToken.current()
      return token ? { [CLAUDE_TOKEN_ENV]: token } : {}
    },
    userDataDir: app.getPath('userData'),
    app: {
      version: deps.version,
      channel: channelForVersion(app.getVersion()) === 'nightly' ? 'nightly' : 'latest',
    },
    packaged: app.isPackaged,
    resourcesDir: app.isPackaged ? process.resourcesPath : null,
    appRoot: app.getAppPath(),
    isDefaultProfile: app.isPackaged && !readStudioEnv('SPRINTENGINE_USER_DATA_DIR')?.trim(),
    startedBy: `Studio on ${hostname()}`,
    fetch: (url, init) => net.fetch(url, init),
    broadcast: (channel, payload) => broadcastToAllWindows(channel, payload),
    onForget: (saved, options) =>
      panePartitions.forget(saved.id, {
        clearBrowsingData: options.clearBrowsingData,
        environmentId: saved.environmentId,
      }),
    log: (message) => {
      void writeDiagnosticLog({ level: 'info', title: 'SSH machine', message, source: 'workspace' })
    },
  })
  registerSshEnvironmentsIpc(ipcMain, sshEnvironments)
  // Chats in containers (docs/design/container-chats.md): each one a saved
  // machine of the list above, reached over `docker exec` on its host.
  const imagePaths = {
    packaged: app.isPackaged,
    resourcesDir: app.isPackaged ? process.resourcesPath : null,
    appRoot: app.getAppPath(),
  }
  const containers = new ContainerChats({
    machines: sshEnvironments,
    image: () => readAgentImage(imagePaths),
    hostLabel: (host) =>
      host.kind === 'local'
        ? process.platform === 'darwin'
          ? 'this Mac'
          : 'this computer'
        : (sshEnvironments.get(host.machine)?.label ?? 'that SSH machine'),
    onChange: () => containersDomain.changed(),
    log: (message) => {
      void writeDiagnosticLog({ level: 'info', title: 'Container', message, source: 'workspace' })
    },
  })
  // What the desktop's Studio serves of them (`containers.*`). A token set or
  // forgotten reaches the servers already running in containers here by
  // restarting them.
  const containersDomain: DesktopContainersDomain = createContainersDomain({
    containers,
    token: containerToken,
    // What each create, push and remove did, by the client's command id, kept
    // on disk: one sent again after the server restarted is answered, not redone.
    receipts: new ContainerCommandReceipts({ path: join(app.getPath('userData'), 'container-commands.json') }),
    onTokenChanged: () => void sshEnvironments.restartContainerServers(),
  })
  // The pane's tabs for a workspace on an SSH machine: that machine's own
  // partition, behind an authenticated proxy on loopback that sends their
  // traffic through the machine (phase 8 spec, 6.8; decisions R75, R76).
  const panePartitions: PanePartitions = new PanePartitions({
    machineOf: (workspaceId) => {
      const environment = deps.workspaceEnvironment(workspaceId)
      return environment?.kind === 'ssh' && sshEnvironments.get(environment.id)
        ? { id: environment.id, label: sshEnvironments.get(environment.id)?.label ?? environment.label }
        : null
    },
    environmentIdOf: (id) => sshEnvironments.get(id)?.environmentId ?? null,
    traffic: (id) => sshEnvironments.get(id)?.settings.paneTraffic ?? 'off',
    current: (id) => sshEnvironments.connection(id),
    connect: (id, ms) => sshEnvironments.connectQuietly(id, ms),
    sessionFor: (partition) => session.fromPartition(partition),
    log: (message) => {
      void writeDiagnosticLog({ level: 'info', title: 'SSH machine', message, source: 'workspace' })
    },
  })
  allowMachinePartitions((partition) => panePartitions.isPrepared(partition))
  // Chromium asks the forward's credential through the `login` event; it is
  // given only to the machine's own partition, for its own port.
  app.on('login', (event, webContents, _details, authInfo, callback) => {
    if (!authInfo.isProxy || !webContents) return
    const own = webContents.session
    const partition =
      panePartitions.preparedPartitions().find((candidate) => session.fromPartition(candidate) === own) ?? null
    const credential = panePartitions.answerLogin(partition, authInfo)
    if (!credential) return
    event.preventDefault()
    callback(credential.username, credential.password)
  })
  app.on('before-quit', () => void panePartitions.shutdown())
  app.on('before-quit', () => sshEnvironments.shutdown())
  void app.whenReady().then(() => {
    // Asleep or on another network, a session's socket may be dead: ask it
    // now rather than wait out the keepalive (phase 8 spec, 7).
    const wake = () => sshEnvironments.wake()
    powerMonitor.on('resume', wake)
    powerMonitor.on('unlock-screen', wake)
    let online = net.isOnline()
    const poll = setInterval(() => {
      const now = net.isOnline()
      if (now && !online) wake()
      online = now
    }, 5_000)
    poll.unref?.()
  })

  if (deps.server) {
    serveSshToServer(deps.server, sshEnvironments)
    serveContainersToServer(deps.server.rpc, containersDomain)
  }
  return { environments: sshEnvironments, panes: panePartitions, containers, containersDomain }
}

/**
 * The desktop's server out of process asks main for relay streams: each is
 * opened on the machine's session here and handed over as a message port.
 * Main tells it when a machine connects, so it follows that machine's chats,
 * and again for each one connected when a restarted server comes up.
 */
function serveSshToServer(server: ShellServerLink, environments: SshEnvironments): void {
  server.rpc.handle(SHELL_METHODS.sshOpen, async (params) => {
    const { key, purpose } = (params ?? {}) as { key?: unknown; purpose?: unknown }
    if (typeof key !== 'string' || !/^ssh:[A-Za-z0-9_-]+$/u.test(key)) throw new Error('That is not an SSH machine.')
    if (purpose !== 'studio') throw new Error('That is not a stream the server opens.')
    const { stream, label } = await environments.openStream(key, purpose)
    const { port1, port2 } = new MessageChannelMain()
    const clientId = prefixedId('ssh', 6)
    if (!server.attachSshPort?.(clientId, port2)) {
      stream.destroy()
      port1.close()
      throw new Error('Studio server is restarting.')
    }
    splicePort(port1, stream)
    return { clientId, label }
  })
  environments.onConnected((connection) => server.rpc.emit(SERVER_EVENTS.sshConnected, { key: connection.key }))
  server.onServing(() => {
    for (const key of environments.connectedKeys()) server.rpc.emit(SERVER_EVENTS.sshConnected, { key })
  })
}
