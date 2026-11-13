import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, test, vi } from 'vitest'

// The IPC inventory (src/shared/ipc-inventory.ts) against what the app really
// registers and uses, found by running it rather than by reading a table:
//
// - every registration site main and the server have, driven on a recording
//   `ipcMain`, the module kernel included, with the bundled modules and an
//   installed (not bundled) extension loaded through the third-party loader;
// - every `window.api` member the preload builds, called with stand-ins, on a
//   recording router.
//
// Each side is then held to the inventory both ways, and each run is checked
// to have reached every registration and every preload call written in the
// source, so a site nobody drives cannot hide a channel. Last, the server rows
// are counted per area: the ratchet that lets channels leave IPC and none join.

type Seen = { channel: string; dir: 'invoke' | 'send' | 'push'; at: string[] }

const ROOT = join(__dirname, '..', '..')
const preloadSeen: Seen[] = []

/** The source lines that led here, as `src/…:line`, innermost first. */
function callers(): string[] {
  const out: string[] = []
  for (const line of (new Error().stack ?? '').split('\n')) {
    const match = /\(?([^\s()]+):(\d+):\d+\)?$/u.exec(line.trim())
    if (!match?.[1] || !match[1].startsWith('/')) continue
    const path = relative(ROOT, match[1])
    if (path.startsWith('src/') && !path.endsWith('.test.ts')) out.push(`${path}:${match[2]}`)
  }
  return out
}

/** Answers anything: every member, call and construction gives another one, and as text it is `ID`. */
function anything(): any {
  const target = function () {} as unknown as Record<PropertyKey, unknown>
  return new Proxy(target, {
    get(_target, property) {
      if (property === 'then') return undefined
      if (property === Symbol.toPrimitive) return () => 'ID'
      if (property === Symbol.iterator) return function* () {}
      if (property === 'length') return 0
      return anything()
    },
    apply: () => anything(),
    construct: () => anything(),
  })
}

function hearOnce(listener: (...args: unknown[]) => void): void {
  try {
    listener(anything(), anything(), 1)
  } catch {
    // A listener that refuses a stand-in message is caught by the call-site check.
  }
}

vi.mock('electron', () => {
  const out: Record<string, unknown> = {}
  for (const name of [
    'BaseWindow',
    'BrowserWindow',
    'MessageChannelMain',
    'Menu',
    'MenuItem',
    'Notification',
    'Tray',
    'WebContentsView',
    'autoUpdater',
    'clipboard',
    'contextBridge',
    'crashReporter',
    'desktopCapturer',
    'dialog',
    'globalShortcut',
    'ipcMain',
    'ipcRenderer',
    'nativeImage',
    'nativeTheme',
    'net',
    'powerMonitor',
    'powerSaveBlocker',
    'protocol',
    'safeStorage',
    'screen',
    'session',
    'shell',
    'systemPreferences',
    'utilityProcess',
    'webContents',
    'webFrame',
    'webUtils',
  ])
    out[name] = anything()
  const rest = anything()
  const app: Record<string, unknown> = {
    getPath: () => tmpdir(),
    getVersion: () => '0.0.0',
    getName: () => 'Studio',
    getAppPath: () => process.cwd(),
    getLocale: () => 'en',
    isPackaged: false,
  }
  out.app = new Proxy(app, {
    get: (target, property) => (property in target ? target[property as string] : rest[property]),
  })
  return { ...out, default: out }
})

vi.mock('../preload/ipc-router', () => {
  const ipc: any = {
    invoke: (channel: string) => {
      preloadSeen.push({ channel, dir: 'invoke', at: callers() })
      return Promise.resolve(anything())
    },
    send: (channel: string) => {
      preloadSeen.push({ channel, dir: 'send', at: callers() })
    },
    // A listener hears one stand-in message at once, so what it sends back is reached too.
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      preloadSeen.push({ channel, dir: 'push', at: callers() })
      hearOnce(listener)
      return ipc
    },
    once: (channel: string, listener: (...args: unknown[]) => void) => {
      preloadSeen.push({ channel, dir: 'push', at: callers() })
      hearOnce(listener)
      return ipc
    },
    removeListener: () => ipc,
    removeAllListeners: () => ipc,
  }
  return { ipc }
})

import { apiModules } from '../preload/api-surface'
import { SERVER_IPC_CHANNELS } from '../shared/ipc-channel-owners'
import { IPC_INVENTORY, ipcInventoryRow, type IpcServerArea } from '../shared/ipc-inventory'
import { WEB_TUNNEL_CHANNELS } from '../shared/web-client'
import { registerServerDomainIpc, type ServerDomainIpcDeps } from '../server/desktop/server-ipc'
import { onRendererBootComplete } from './boot-reveal'
import { createHostRecordingEncoder } from './browser/recording-encoder'
import { attachBuildSkewWatch } from './build-skew'
import { createCanvasWorkerTransport } from './canvas/canvas-worker-window'
import { registerChatLinkIpc } from './chat-link-ipc'
import { registerSshPreviewIpc } from './environments/ssh/ssh-preview'
import { registerAppRestartIpc } from './ipc/app-restart-ipc'
import { registerEnvironmentsIpc } from './ipc/environments-ipc'
import { registerSshEnvironmentsIpc } from './ipc/ssh-environments-ipc'
import { registerStudioServerIpc } from './ipc/studio-server-ipc'
import { loadMainModules } from './module-host/load-modules'
import {
  ConversationHostToken,
  ConversationLaunchServiceToken,
  ConversationRuntimeToken,
  WorkspaceRegistryToken,
} from './module-host/service-tokens'
import { scheduledAgentsSwitchModule } from './modules/scheduled-agents-switch'
import { AGENT_RUNTIME_MANIFEST } from './modules/agent-runtime-module'
import { computeModuleFileDigestsSync, manifestFingerprint } from './modules/module-signature'
import { planThirdPartyMainModules } from './modules/third-party-main-loader'
import { discoverUserModulesSync } from './modules/user-module-registry'
import { registerCoreIpc } from './register-core-ipc'
import { attachStartupTimeline } from './startup-timeline'

/**
 * Server rows per area. A new server channel raises its area's count and fails
 * here: make it a Studio protocol method instead. Moving channels off IPC
 * deletes their rows; lower the count in the same change.
 */
const SERVER_ROWS: Readonly<Record<IpcServerArea, number>> = {
  conversations: 0,
  terminals: 3,
  modules: 0,
  extensions: 0,
  'paired-machines': 0,
  access: 0,
  workspaces: 3,
  'web-tab': 6,
}

/** Registrations written in the source that registering at boot does not reach, each with why. */
const NOT_DRIVEN: ReadonlyArray<{ file: string; registers: string; channel: string; why: string }> = [
  {
    file: 'src/main/ipc/window-ipc.ts',
    registers: "'window:dock-diff-ack'",
    channel: 'window:dock-diff-ack',
    why: 'registered per dock offer, while it waits for a window to take it',
  },
  {
    file: 'src/main/ipc/window-ipc.ts',
    registers: "'window:diff-to-chat-ack'",
    channel: 'window:diff-to-chat-ack',
    why: 'registered per offer, while it waits for a chat to take it',
  },
  {
    file: 'src/main/startup-timeline.ts',
    registers: 'STARTUP_MARK_CHANNEL',
    channel: 'app:startup-mark',
    why: 'registered only while startup is being measured',
  },
]

/** `window.api` members that use no channel, each with why. */
const NO_CHANNEL: Readonly<Record<string, string>> = {
  getWindowZoomFactor: 'reads this frame through webFrame',
  getPathForFile: "reads a dropped file's path through webUtils",
  uploadFiles: 'reads files the person picked in this window',
  startupTimelineEnabled: 'a value from the command line',
}

/** Push rows the api modules do not listen on, and the file that does. */
const PUSHES_ELSEWHERE: Readonly<Record<string, string>> = {
  'studio-server:port': 'src/preload/ipc-router.ts',
  'splash:progress': 'src/preload/splash.ts',
}

const scratch = mkdtempSync(join(tmpdir(), 'se-ipc-inventory-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function recordingIpcMain(seen: Seen[]): any {
  const ipc: any = {}
  const record = (dir: 'invoke' | 'send') => (channel: string) => {
    seen.push({ channel, dir, at: callers() })
    return ipc
  }
  for (const name of ['handle', 'handleOnce']) ipc[name] = record('invoke')
  for (const name of ['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']) ipc[name] = record('send')
  ipc.removeHandler = () => undefined
  ipc.removeListener = () => ipc
  ipc.removeAllListeners = () => ipc
  return ipc
}

function serverDomainStubs(dataDir: string): ServerDomainIpcDeps {
  return {
    core: {
      ...anything(),
      platform: { paths: { dataDir: () => dataDir } },
      workspaceSyncService: { subscribeEvents: () => () => undefined },
      agentLaunchSettings: { subscribe: () => () => undefined, get: () => ({ cliRuntimes: {} }) },
      hosts: { subscribe: () => () => undefined },
      workspaceRegistry: { getRecords: () => [] },
      conversations: anything(),
      usageLimitResumes: anything(),
      scheduledMessages: anything(),
      textGenerationSettings: anything(),
      conversationCommands: () => anything(),
    } as never,
    gateway: anything(),
    studioRpc: { provideChat: () => undefined } as never,
    terminalHandoff: anything(),
  }
}

/** An extension as Settings installs one: a folder in the user module root, trusted by its fingerprint. */
function installExtension(id: string): ReturnType<typeof planThirdPartyMainModules> {
  const root = join(scratch, 'modules')
  const moduleRoot = join(root, id)
  mkdirSync(join(moduleRoot, 'dist'), { recursive: true })
  writeFileSync(
    join(moduleRoot, 'dist', 'main.cjs'),
    `exports.registerMain = (host) => host.registerMethods({ forecast: { access: 'read', params: () => ({ ok: true, params: {} }), handler: () => ({ ok: true, result: 'sunny' }) } })\n`,
  )
  writeFileSync(
    join(moduleRoot, 'manifest.json'),
    JSON.stringify({
      id,
      displayName: id,
      version: 1,
      defaultEnabled: true,
      permissions: ['module:bridge'],
      entry: { main: 'dist/main.cjs' },
      files: computeModuleFileDigestsSync(moduleRoot).files,
    }),
  )
  const listed = discoverUserModulesSync(root, { trustedModules: new Map() }).modules.find(
    (entry) => entry.manifest.id === id,
  )
  assert.ok(listed, 'the installed extension is discovered')
  const trusted = new Map([[id, manifestFingerprint(listed.manifest)]])
  return planThirdPartyMainModules(discoverUserModulesSync(root, { trustedModules: trusted }))
}

/** Every non-test `.ts` file under a directory of the repository. */
function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...sources(path))
    else if (/\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$|test-helper|\.d\.ts$/u.test(entry.name)) out.push(path)
  }
  return out
}

/** The `file:line`s in `files` whose text matches `pattern`. */
function linesMatching(files: readonly string[], pattern: RegExp): Map<string, string> {
  const out = new Map<string, string>()
  for (const file of files) {
    readFileSync(join(ROOT, file), 'utf8')
      .split('\n')
      .forEach((text, index) => {
        if (pattern.test(text)) out.set(`${file}:${index + 1}`, text.trim())
      })
  }
  return out
}

// A registration as the source writes it: on `ipcMain` (or a registry or
// wrapper of it named `ipc`), or through the SSH machines' local `handle`.
// A module registers none: it declares methods, served over the Studio protocol.
const REGISTRATION =
  /(?:^|[^\w.])(?:deps\.)?(?:ipcMain|ipc)\.(?:handle|handleOnce|on|once|addListener|prependListener|prependOnceListener)\(|^\s*handle\(SSH_ENV_CHANNELS\./u

// A preload call on its router.
const PRELOAD_CALL = /\b(?:ipcRenderer|ipc)\.(?:invoke|send|sendSync|on|once)\(/u

test('what main and the server register, and what the preload uses, is the inventory, every site reached', async () => {
  // ── Main: every registration site ──
  const shellSeen: Seen[] = []
  const shell = recordingIpcMain(shellSeen)
  registerCoreIpc(shell, anything(), true, { server: anything() })
  attachBuildSkewWatch(shell, anything())
  attachStartupTimeline(shell)
  onRendererBootComplete(shell, () => undefined)
  registerAppRestartIpc(shell, anything())
  registerSshPreviewIpc(shell, { enabled: false, fromEnvironment: false }, scratch)
  registerStudioServerIpc(shell, anything())
  registerSshEnvironmentsIpc(shell, anything())
  registerEnvironmentsIpc(shell, anything())
  registerChatLinkIpc({ ipcMain: shell, router: anything(), windowOf: anything(), isWorkspaceWindow: anything() })
  createHostRecordingEncoder({ ipcMain: shell, tabs: anything() })
  createCanvasWorkerTransport({ ipcMain: shell })

  // ── The server's domains and the module kernel, with an installed extension ──
  const serverSeen: Seen[] = []
  const server = recordingIpcMain(serverSeen)
  const domains = registerServerDomainIpc(server, serverDomainStubs(scratch))
  const installed = installExtension('weather-deck')
  const modules = loadMainModules({
    modules: [
      {
        manifest: AGENT_RUNTIME_MANIFEST,
        registerMain(host) {
          host.provideService(ConversationLaunchServiceToken, () => anything())
          host.provideService(ConversationRuntimeToken, () => anything())
          host.provideService(ConversationHostToken, () => anything())
          host.provideService(WorkspaceRegistryToken, () => anything())
        },
      },
      // The core's schedules, held by the kernel under the person's switch.
      scheduledAgentsSwitchModule(
        { service: anything(), moduleRegistry: () => anything(), start: async () => {}, stop: async () => {} } as never,
        () => undefined,
      ),
      ...installed.modules,
    ],
    ineligible: installed.ineligible,
  })
  assert.deepEqual(modules.report.errors, [])
  assert.ok(modules.report.loaded.includes('weather-deck'), 'the installed extension loads')

  // ── The preload: every member, with stand-ins ──
  const usedBy = new Map<string, Set<string>>()
  for (const [name, member] of Object.entries(apiModules)) {
    const before = preloadSeen.length
    if (typeof member === 'function') {
      try {
        const result = (member as (...args: unknown[]) => unknown)(...Array.from({ length: 8 }, anything))
        const settled =
          result && typeof (result as Promise<unknown>).then === 'function'
            ? await (result as Promise<unknown>).catch(() => undefined)
            : result
        // An unsubscribe, a stop: what a member hands back may use a channel too.
        if (typeof settled === 'function') await Promise.resolve(settled()).catch(() => undefined)
      } catch {
        // A member that refuses stand-ins is caught by the call-site check below.
      }
    }
    for (const seen of preloadSeen.slice(before)) {
      const users = usedBy.get(seen.channel) ?? new Set<string>()
      users.add(name)
      usedBy.set(seen.channel, users)
    }
    if (preloadSeen.length === before) assert.ok(name in NO_CHANNEL, `window.api.${name} used no channel`)
  }
  for (const name of Object.keys(NO_CHANNEL)) {
    assert.ok(name in apiModules, `NO_CHANNEL names window.api.${name}, which no longer exists`)
  }

  // ── Registrations against the inventory ──
  for (const seen of [...shellSeen, ...serverSeen]) {
    const row = IPC_INVENTORY[seen.channel]
    assert.ok(row, `"${seen.channel}" is registered (${seen.at[0]}) but not in src/shared/ipc-inventory.ts`)
    assert.equal(row.dir, seen.dir, `"${seen.channel}" is registered as ${seen.dir}, listed as ${row.dir}`)
  }
  const registered = new Set([...shellSeen, ...serverSeen].map((seen) => seen.channel))
  // Terminals are the Studio protocol's (`terminal.*`, packages/studio-protocol/src/terminals.ts):
  // no window reaches one over IPC, and no preload member offers one.
  assert.deepEqual(
    [...registered, ...preloadSeen.map((seen) => seen.channel), ...Object.keys(IPC_INVENTORY)].filter((channel) =>
      channel.startsWith('terminal:'),
    ),
    [],
    'no terminal: channel is registered, used or listed',
  )
  assert.deepEqual(
    Object.keys(apiModules).filter((name) => /^terminal|^(on|set)Terminal/u.test(name)),
    [],
    'no preload member starts with terminal',
  )
  for (const [channel, row] of Object.entries(IPC_INVENTORY)) {
    if (row.dir === 'push') continue
    // The web front door's own tunnel channels, held to its table below.
    if (channel in WEB_TUNNEL_CHANNELS) continue
    if (NOT_DRIVEN.some((entry) => entry.channel === channel)) continue
    assert.ok(registered.has(channel), `"${channel}" is listed as ${row.dir} but nothing registers it`)
  }
  for (const channel of Object.keys(WEB_TUNNEL_CHANNELS)) {
    const row = IPC_INVENTORY[channel]
    assert.ok(row && 'server' in row && row.dir === 'invoke', `the web tunnel's "${channel}" is a server invoke row`)
  }

  // An installed extension declares methods, served over the Studio protocol,
  // and registers no IPC at all.
  assert.deepEqual(modules.kernel.declaredMethods('weather-deck'), [{ name: 'forecast', access: 'read' }])
  assert.deepEqual(
    [...registered].filter((channel) => channel.startsWith('weather-deck')),
    [],
    'an installed extension registers no IPC channel',
  )

  // What the server registers is what the preload routes to it out of process
  // (SERVER_IPC_CHANNELS); all of it is server rows.
  assert.deepEqual(
    [...new Set(serverSeen.map((seen) => seen.channel))].sort(),
    Object.keys(SERVER_IPC_CHANNELS).sort(),
    'what the server registers and SERVER_IPC_CHANNELS differ',
  )
  for (const channel of Object.keys(SERVER_IPC_CHANNELS)) {
    const row = IPC_INVENTORY[channel]
    assert.ok(row && 'server' in row, `"${channel}" runs on the server but its row is not a server row`)
  }
  void domains.conversationCommands.dispose()
  await modules.kernel.runShutdownBegin()
  await modules.kernel.runShutdown()

  // ── The preload against the inventory ──
  const listened = new Set<string>()
  for (const seen of preloadSeen) {
    const row = ipcInventoryRow(seen.channel)
    assert.ok(row, `the preload uses "${seen.channel}" (${seen.at[0]}), which is not in src/shared/ipc-inventory.ts`)
    assert.equal(row.dir, seen.dir, `the preload uses "${seen.channel}" as ${seen.dir}, listed as ${row.dir}`)
    if (seen.dir === 'push') listened.add(seen.channel)
  }
  for (const [channel, row] of Object.entries(IPC_INVENTORY)) {
    if (row.dir !== 'push' || channel in PUSHES_ELSEWHERE) continue
    const heard = [...listened].some((name) => name === channel || ipcInventoryRow(name) === row)
    assert.ok(heard, `"${channel}" is listed as a push but no window.api member listens on it`)
  }
  for (const [channel, file] of Object.entries(PUSHES_ELSEWHERE)) {
    assert.equal(IPC_INVENTORY[channel]?.dir, 'push', channel)
    const text = readFileSync(join(ROOT, file), 'utf8')
    assert.ok(text.includes(`'${channel}'`) || /SERVER_PORT_CHANNEL/u.test(text), `${file} listens on "${channel}"`)
  }

  // ── Every registration and preload call written in the source was reached ──
  const reached = new Set([...shellSeen, ...serverSeen, ...preloadSeen].flatMap((seen) => seen.at))
  const mainSources = [...sources('src/main'), ...sources('src/server')]
  const explained = (at: string, text: string) =>
    NOT_DRIVEN.some((entry) => at.startsWith(`${entry.file}:`) && text.includes(entry.registers))
  const unreached = [...linesMatching(mainSources, REGISTRATION)].filter(
    ([at, text]) => !reached.has(at) && !explained(at, text),
  )
  assert.deepEqual(unreached, [], 'registrations this test does not drive: drive them, or say why in NOT_DRIVEN')
  for (const entry of NOT_DRIVEN) {
    const hits = [...linesMatching([entry.file], REGISTRATION).values()].filter((text) =>
      text.includes(entry.registers),
    )
    assert.ok(hits.length > 0, `NOT_DRIVEN names ${entry.registers} in ${entry.file}, which no longer registers it`)
  }
  const preloadApi = sources('src/preload/api')
  const preloadUnreached = [...linesMatching(preloadApi, PRELOAD_CALL)].filter(([at]) => !reached.has(at))
  assert.deepEqual(preloadUnreached, [], 'preload calls no window.api member reached')

  // Only the router speaks Electron's IPC in an app window's preload; the
  // splash and a browser pane's guest have their own preloads, on their own
  // channels.
  const electronIpc = linesMatching(sources('src/preload'), /\bipcRenderer\b.*from 'electron'/u)
  assert.deepEqual([...electronIpc.keys()].map((at) => at.slice(0, at.lastIndexOf(':'))).sort(), [
    'src/preload/browser-guest.ts',
    'src/preload/ipc-router.ts',
    'src/preload/splash.ts',
  ])

  // ── The ratchet ──
  const counted: Record<string, number> = {}
  for (const row of Object.values(IPC_INVENTORY))
    if ('server' in row) counted[row.server] = (counted[row.server] ?? 0) + 1
  for (const area of Object.keys(SERVER_ROWS) as IpcServerArea[]) counted[area] ??= 0
  assert.deepEqual(
    counted,
    SERVER_ROWS,
    "server rows changed. A new window.api channel that is not the shell's own belongs on the Studio protocol, " +
      'not IPC; if channels moved off IPC, lower their area in SERVER_ROWS.',
  )
})
