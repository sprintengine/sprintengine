import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import {
  STUDIO_METHODS,
  STUDIO_TOPICS,
  studioGrantAllows,
  studioGrantAllowsTopic,
} from '../../../../packages/studio-protocol/src/methods'
import type { StudioGrant } from '../../../../packages/studio-protocol/src/public'
import { TAILNET_SCOPES, type TailnetScope } from '../../../shared/tailnet'
import { createTailnetDeviceStore } from './tailnet-devices'
import { createTailnetDeviceAuthenticator, tailnetDeviceGrant } from './tailnet-studio-endpoint'

// Everything a paired device (the phone, another desktop's window) reaches on
// `/tailnet/v1/studio`, method by method and topic by topic, read from the
// contract's own declarations through the device's real grant. The plan's
// API-family table (design-lane-on-protocol) is what a device is given; this
// is that table as built. Every method and topic the contract defines is
// either in it or refused below with a reason, so a new one fails here until
// someone decides whether a device reaches it, and a widening is a change to
// this file someone reviews.
//
// Each row names the device scopes that reach it on their own. A device
// holding several reaches what any of them does.

const ANY = TAILNET_SCOPES
const CHAT_READ = ['conversation:read', 'conversation:operate'] as const
const CHAT_OPERATE = ['conversation:operate'] as const
const WORKSPACE = ['workspace:read', 'workspace:operate'] as const

const DEVICE_METHODS: Readonly<Record<string, readonly TailnetScope[]>> = {
  // The connection itself, and whether this Studio needs updating: any authenticated grant.
  'server.info': ANY,
  'server.ping': ANY,
  'update.status': ANY,

  // Chat list, following a chat, its changes, side reads, search, approval rules.
  'conversation.list': CHAT_READ,
  'conversation.loadEarlier': CHAT_READ,
  'conversation.toolDetail': CHAT_READ,
  'conversation.event': CHAT_READ,
  'conversation.turnDiff': CHAT_READ,
  'conversation.cancelSideQuestion': CHAT_READ,
  'conversation.contextBreakdown': CHAT_READ,
  'conversation.searchFiles': CHAT_READ,
  'conversation.listCommands': CHAT_READ,
  'conversation.commands': CHAT_READ,
  'conversation.changesDiff': CHAT_READ,
  'conversation.changedFile': CHAT_READ,
  'conversation.attachment': CHAT_READ,
  'conversation.planDocument': CHAT_READ,
  'conversation.threads': CHAT_READ,
  'conversation.search': CHAT_READ,
  'conversation.cancelSearch': CHAT_READ,
  'conversation.approvalRules': CHAT_READ,
  'session.list': CHAT_READ,
  'session.cancelSideQuestion': CHAT_READ,
  'session.contextBreakdown': CHAT_READ,

  // Driving a chat: commands, history edits, lifecycle marks, uploads.
  'conversation.send': CHAT_OPERATE,
  'conversation.interrupt': CHAT_OPERATE,
  'conversation.resolveApproval': CHAT_OPERATE,
  'conversation.answerQuestion': CHAT_OPERATE,
  'conversation.resolvePlan': CHAT_OPERATE,
  'conversation.setPermissionPreset': CHAT_OPERATE,
  'conversation.setModel': CHAT_OPERATE,
  'conversation.cancelQueued': CHAT_OPERATE,
  'conversation.stopSubagent': CHAT_OPERATE,
  'conversation.messageSubagent': CHAT_OPERATE,
  'conversation.setReasoningEffort': CHAT_OPERATE,
  'conversation.mcpServerAction': CHAT_OPERATE,
  'conversation.restartSession': CHAT_OPERATE,
  'conversation.scheduleSend': CHAT_OPERATE,
  'conversation.sendScheduledNow': CHAT_OPERATE,
  'conversation.cancelScheduled': CHAT_OPERATE,
  'conversation.usageLimitResume': CHAT_OPERATE,
  'conversation.stop': CHAT_OPERATE,
  'conversation.askSideQuestion': CHAT_OPERATE,
  'conversation.settle': CHAT_OPERATE,
  'conversation.visit': CHAT_OPERATE,
  'conversation.revert': CHAT_OPERATE,
  'conversation.rewind': CHAT_OPERATE,
  'conversation.handoff': CHAT_OPERATE,
  'session.start': CHAT_OPERATE,
  'session.send': CHAT_OPERATE,
  'session.interrupt': CHAT_OPERATE,
  'session.respond': CHAT_OPERATE,
  'session.setPermission': CHAT_OPERATE,
  'session.setModel': CHAT_OPERATE,
  'session.stop': CHAT_OPERATE,
  'session.suspend': CHAT_OPERATE,
  'session.mcpServerAction': CHAT_OPERATE,
  'session.stopSubagent': CHAT_OPERATE,
  'session.messageSubagent': CHAT_OPERATE,
  'session.askSideQuestion': CHAT_OPERATE,
  'uploads.begin': CHAT_OPERATE,
  'uploads.append': CHAT_OPERATE,
  'uploads.discard': CHAT_OPERATE,
  // Starting a chat, or a fork of one: `conversation:operate` carries `conversation:create`.
  'conversation.create': CHAT_OPERATE,
  'conversation.fork': CHAT_OPERATE,
  // Stopping an agent's watch on a pull request it opened.
  'pullRequests.unwatch': CHAT_OPERATE,

  // Every chat's held and scheduled messages and limit resumes at once: the
  // per-chat watches and commands above, read and changed for all chats.
  'scheduledMessages.get': CHAT_READ,
  'usageLimitResumes.get': CHAT_READ,
  'scheduledMessages.update': CHAT_OPERATE,
  'scheduledMessages.hold': CHAT_OPERATE,
  'usageLimitResumes.update': CHAT_OPERATE,

  // Discovery, and the pull requests a workspace's chats opened.
  'workspaces.list': WORKSPACE,
  'workspaces.checkout': WORKSPACE,
  'workspaces.extensions': WORKSPACE,
  'cliRuntimes.list': WORKSPACE,
  'pullRequests.list': WORKSPACE,
  'pullRequests.refresh': WORKSPACE,
}

const DEVICE_TOPICS: Readonly<Record<string, readonly TailnetScope[]>> = {
  'conversation.session': CHAT_READ,
  'conversation.queued': CHAT_READ,
  'conversation.scheduled': CHAT_READ,
  'conversation.usageLimits': CHAT_READ,
  'conversation.subagents': CHAT_READ,
  'conversation.changes': CHAT_READ,
  'conversation.commands': CHAT_READ,
  'conversation.events': CHAT_READ,
  'scheduledMessages.changed': CHAT_READ,
  'usageLimitResumes.changed': CHAT_READ,
  'pullRequests.changed': WORKSPACE,
}

/**
 * What no device reaches, whatever it was paired with, and why. Each of these
 * was reachable before; listed so the reason is next to the row it removed.
 */
const REFUSED_TO_DEVICES: Readonly<Record<string, string>> = {
  'localServers.list': 'an agent’s servers on this machine, the commands that start them and their output',
  'localServers.run': 'starts a program on this machine',
  'localServers.stop': 'stops a program on this machine',
  'localServers.remove': 'drops what an agent recorded',
  'localServers.changed': 'the list’s change push',
  'tools.grant': 'changes which apps’ tools an agent may call: settings:write, which no device holds',
  'tools.grants': 'client tools, for an app that offers them (tools:offer)',
  'tools.catalog': 'client tools, for an app that offers them (tools:offer); the topic too',
  'textGeneration.chatTitle': 'runs an agent CLI here outside any chat, for the window’s own boxes',
  'commitMessage.draft': 'the same, over a checkout on this disk',
  'commitMessage.cancel': 'the same',
}

/**
 * Everything else a device never reaches, family by family, with the reason.
 * With the tables above this is a decision for every method and topic the
 * contract defines: a new one that is in none of them fails, whether a device
 * reaches it or not, so whoever adds it says whether a device may.
 */
const NOT_FOR_DEVICES: Readonly<Record<string, string>> = Object.fromEntries(
  (
    [
      [
        'terminals: an owner’s by declaration, never a device’s (owner ruling)',
        [
          'terminal.list',
          'terminal.status',
          'terminal.open',
          'terminal.resume',
          'terminal.write',
          'terminal.ack',
          'terminal.resize',
          'terminal.setVisible',
          'terminal.suspend',
          'terminal.close',
          'terminal.setReapExempt',
          'terminal.takeUndeliveredPrompts',
          'terminal.configure',
          'terminal.output',
          'terminal.sessions',
          'terminal.promptUndelivered',
          'session.terminalHandoff',
        ],
      ],
      [
        'files on this disk (files:read, files:write), which no device holds',
        [
          'files.search',
          'files.cancelSearch',
          'files.stat',
          'files.readImage',
          'files.repoRoot',
          'files.roots',
          'files.list',
          'files.read',
          'files.write',
          'files.remove',
          'files.watch',
        ],
      ],
      [
        'providers, their keys and sign-in, and the CLIs installed here (providers:read, settings:write, environment:maintain)',
        [
          'providers.list',
          'providers.models',
          'providers.secretStatus',
          'providers.signIn',
          'providers.setSecret',
          'providers.clearSecret',
          'cliRuntimes.detect',
          'cliRuntimes.installMethods',
          'cliRuntimes.install',
          'cliRuntimes.update',
          'cliRuntimes.updateAll',
          'cliRuntimes.output',
          'cliRuntimes.updateAllProgress',
          'cliVersions.advisories',
          'cliVersions.setEnabled',
          'cliVersions.changed',
          'cliModels.discover',
          'cliModels.changed',
          'environment.readiness',
          'usageLimits.get',
          'usageLimits.changed',
          'usage.report',
        ],
      ],
      [
        'this Studio’s settings, launch settings and agent setup (settings:write, or an owner’s)',
        [
          'conversation.revokeApprovalRule',
          'launchSettings.get',
          'launchSettings.update',
          'launchSettings.migrate',
          'launchSettings.changed',
          'textGeneration.setSettings',
          'usageLimitResumes.setAuto',
          'mcp.sync',
          'agentConfig.detect',
          'agentConfig.adopt',
          'builtinSkills.list',
          'builtinSkills.status',
          'areaSkills.get',
          'areaSkills.setEnabled',
          'areaSkills.dismiss',
          'areaSkills.changed',
        ],
      ],
      [
        'the knowledge folders and their activity hook (files:read, or an owner’s)',
        [
          'memory.resolveRoot',
          'memory.index',
          'memory.readPreview',
          'memoryActivity.install',
          'memoryActivity.uninstall',
          'memoryActivity.startWatching',
          'memoryActivity.status',
          'memoryActivity.synapses',
          'memoryActivity.isInstalled',
          'memoryActivity.events',
          'memoryActivity.statusChanged',
          'memoryActivity.synapsesChanged',
        ],
      ],
      [
        'client tools, offered by an app that gives agents its tools (tools:offer)',
        ['tools.offer', 'tools.withdraw', 'tools.focus'],
      ],
      [
        'modules (modules:read, modules:operate)',
        ['module.read', 'module.operate', 'module.events', 'module.notifications'],
      ],
      [
        'what Studio’s own agents report, and importing chats from disk: an owner’s',
        [
          'pullRequests.noteWork',
          'pullRequests.noteToolCall',
          'pullRequests.link',
          'conversationImport.scan',
          'conversationImport.import',
        ],
      ],
      ['updating this Studio (environment:maintain)', ['update.start']],
      [
        'skills, plugins, design systems and cards: what the agents here are given, set up from the desktop (providers:read, files:read or write, settings:write, environment:maintain, or an owner’s)',
        [
          'skillSources.list',
          'skillSources.checkUpdates',
          'skillSources.add',
          'skillSources.addLocal',
          'skillSources.remove',
          'skillSources.sync',
          'skillSources.updated',
          'skills.scan',
          'skills.readFile',
          'skills.install',
          'skills.uninstall',
          'skills.search',
          'skills.popularRepos',
          'skills.ensureUserFolder',
          'skillPlugins.scanLinked',
          'skillPlugins.install',
          'skillPlugins.uninstall',
          'skillPlugins.listInstalled',
          'workspaceSkills.list',
          'installedSkills.list',
          'installedSkills.remove',
          'agentCapabilities.resolve',
          'agentSkills.attach',
          'designSystem.library',
          'designSystem.arrivals',
          'designSystem.register',
          'designSystem.forget',
          'designSystem.read',
          'designSystem.seed',
          'designSystem.lint',
          'designSystem.attach',
          'designSystem.detach',
          'cards.run',
        ],
      ],
    ] as const
  ).flatMap(([reason, names]) => names.map((name) => [name, reason])),
)

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function deviceStore() {
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-device-reach-'))
  dirs.push(dir)
  return createTailnetDeviceStore({ resolveUserDataDir: () => dir })
}

/** The grant a device paired with `scopes` holds on the Studio socket, as the endpoint builds it. */
function grantOf(scopes: readonly TailnetScope[]): StudioGrant {
  const store = deviceStore()
  const { device } = store.mintDevice({
    name: 'android-phone',
    scopes: [...scopes],
    origin: { kind: 'code', by: null },
  })
  return tailnetDeviceGrant(device)
}

type Reach = { methods: string[]; topics: string[] }

function reachOf(grant: StudioGrant | null): Reach {
  if (!grant) return { methods: [], topics: [] }
  return {
    methods: Object.keys(STUDIO_METHODS)
      .filter((method) => studioGrantAllows(grant, method))
      .sort(),
    topics: Object.keys(STUDIO_TOPICS)
      .filter((topic) => studioGrantAllowsTopic(grant, topic))
      .sort(),
  }
}

/** What the table says a device holding `scopes` reaches. */
function expectedReach(scopes: readonly TailnetScope[]): Reach {
  const reached = (table: Readonly<Record<string, readonly TailnetScope[]>>) =>
    Object.entries(table)
      .filter(([, by]) => by.some((scope) => scopes.includes(scope)))
      .map(([name]) => name)
      .sort()
  return { methods: reached(DEVICE_METHODS), topics: reached(DEVICE_TOPICS) }
}

test('the table names only methods and topics the contract defines', () => {
  for (const method of Object.keys(DEVICE_METHODS)) assert.ok(Object.hasOwn(STUDIO_METHODS, method), method)
  for (const topic of Object.keys(DEVICE_TOPICS)) assert.ok(Object.hasOwn(STUDIO_TOPICS, topic), topic)
  for (const name of [...Object.keys(REFUSED_TO_DEVICES), ...Object.keys(NOT_FOR_DEVICES)])
    assert.ok(Object.hasOwn(STUDIO_METHODS, name) || Object.hasOwn(STUDIO_TOPICS, name), name)
})

test('every method and topic has a device decision, and only one', () => {
  const refused = (name: string) => Object.hasOwn(REFUSED_TO_DEVICES, name) || Object.hasOwn(NOT_FOR_DEVICES, name)
  for (const name of Object.keys(REFUSED_TO_DEVICES)) assert.ok(!Object.hasOwn(NOT_FOR_DEVICES, name), name)
  const undecided = [
    ...Object.keys(STUDIO_METHODS).filter((method) => Object.hasOwn(DEVICE_METHODS, method) === refused(method)),
    ...Object.keys(STUDIO_TOPICS).filter((topic) => Object.hasOwn(DEVICE_TOPICS, topic) === refused(topic)),
  ]
  assert.deepEqual(undecided, [], 'each is either in a device table or refused, with its reason')
})

test('each device scope on its own reaches exactly its rows of the table', () => {
  for (const scope of TAILNET_SCOPES)
    assert.deepEqual(reachOf(grantOf([scope])), expectedReach([scope]), `a device paired with ${scope} alone`)
})

test('a fully paired device reaches the whole table and nothing beyond it', () => {
  const reach = reachOf(grantOf(TAILNET_SCOPES))
  assert.deepEqual(reach, {
    methods: Object.keys(DEVICE_METHODS).sort(),
    topics: Object.keys(DEVICE_TOPICS).sort(),
  })
  for (const name of Object.keys(REFUSED_TO_DEVICES))
    assert.ok(!reach.methods.includes(name) && !reach.topics.includes(name), `${name}: ${REFUSED_TO_DEVICES[name]}`)
  // Never a terminal, whatever it holds.
  assert.ok(!reach.methods.some((method) => method.startsWith('terminals.')))
  assert.ok(!reach.topics.some((topic) => topic.startsWith('terminals.')))
})

test('a read-only device follows chats and reads workspaces, and drives, starts or changes nothing', () => {
  const readOnly: TailnetScope[] = ['workspace:read', 'backlog:read', 'conversation:read']
  const reach = reachOf(grantOf(readOnly))
  assert.deepEqual(reach, expectedReach(readOnly))
  for (const method of ['conversation.send', 'conversation.create', 'pullRequests.unwatch', 'uploads.begin'])
    assert.ok(!reach.methods.includes(method), method)
  assert.ok(reach.methods.includes('conversation.list'))
  assert.ok(reach.methods.includes('workspaces.list'))
})

test('a device paired with nothing reaches only the connection and the update status', () => {
  assert.deepEqual(reachOf(grantOf([])), { methods: ['server.info', 'server.ping', 'update.status'], topics: [] })
})

test('a revoked device holds no grant at all, and so reaches nothing', () => {
  const store = deviceStore()
  const { device } = store.mintDevice({
    name: 'android-phone',
    scopes: [...TAILNET_SCOPES],
    origin: { kind: 'code', by: null },
  })
  const auth = createTailnetDeviceAuthenticator({ devices: store, deviceId: device.id, ticket: 'ticket-0123456789' })
  const hello = auth.authenticate({ token: 'ticket-0123456789' }, { name: 'phone' })
  assert.ok(hello.ok)
  const clientId = hello.grant.clientId
  assert.deepEqual(reachOf(auth.grantFor(clientId)), expectedReach(TAILNET_SCOPES))
  store.revokeDevice(device.id)
  assert.equal(auth.grantFor(clientId), null)
  assert.deepEqual(reachOf(auth.grantFor(clientId)), { methods: [], topics: [] })
})
