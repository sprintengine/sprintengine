import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  STUDIO_METHODS,
  STUDIO_METHOD_ACCESS,
  STUDIO_TOPICS,
  STUDIO_TOPIC_ACCESS,
  studioGrantAllows,
  studioGrantAllowsTopic,
  type StudioMethod,
  type StudioTopic,
} from '../src/methods'
import type { StudioAccess } from '../src/permissions'
import { STUDIO_TERMINALS_METHODS, STUDIO_TERMINALS_TOPICS } from '../src/terminals'
import { STUDIO_SCOPES } from '../src/scopes'

// What each grant reaches, method by method: the table a client reads to
// decide whether to offer a control (`studioGrantAllows`), never `grant.owner`.
// An owner holds every scope; a paired client holds the scopes it was given
// and is refused only what is an owner's by declaration, each with its reason;
// a read-only client follows chats and nothing more; a revoked one holds nothing.

const OWNER = { owner: true, scopes: [...STUDIO_SCOPES] }
const PAIRED = { owner: false, scopes: [...STUDIO_SCOPES] }
const READ_ONLY = { owner: false, scopes: ['conversation:read'] }
const REVOKED = { owner: false, scopes: [] as string[] }

/**
 * What only an owner's connection may call, and why: what runs a program or
 * opens a terminal on this machine's screen, or records an agent's own work
 * (the local servers an agent linked here, which `localServers.run` and
 * `.stop` start and stop; a title or a commit message an agent CLI writes
 * outside any chat);
 * of the terminals, the words a person wrote for an agent and the
 * machine-wide idle policy; the launch settings, which name the programs
 * each CLI and MCP server runs here and hold the MCP servers' keys; and what
 * writes the programs and hooks the agent CLIs run (an MCP sync, an adopted
 * configuration, the memory activity hook); a plugin's install and
 * uninstall (its hooks and MCP servers), a design bundle's lint (it runs the
 * bundle's own script) and a card's Go (modules, plugins and MCP servers in
 * one press); an extension's code fetched, reviewed, installed, updated or
 * removed, and a new extension project written on this disk. In git: what moves a branch, rewrites history or discards
 * work, what reaches a remote with this machine's credentials, removing or
 * unlocking agents' worktrees, and the GitHub account Studio holds. Where
 * this machine publishes agents' pages: the setting and the token it holds,
 * a set-up that signs in to the host, and the person's set-up question. A chat's
 * Create PR (`pull-request-create`): its forge, its push, its drafting CLI. The
 * worktree pool and the agents' worktrees (`worktrees.*`, with its streams):
 * this machine's checkouts, which the pool hands out, resets and removes.
 * A project's backlog by its folder (the desktop's own Backlog panel): it
 * names a folder on this machine and writes the files there.
 * A method joins this list with its reason, in the change that makes it an
 * owner's; anything else reaches a paired client by its scope.
 */
const OWNER_ONLY: ReadonlyArray<StudioMethod | StudioTopic> = [
  'agentConfig.adopt',
  'cards.run',
  'commitMessage.cancel',
  'commitMessage.draft',
  'designSystem.lint',
  'environment.deviceTicket',
  'environment.revokeWindow',
  'environment.windowTicket',
  'localServers.changed',
  'localServers.list',
  'localServers.remove',
  'localServers.run',
  'localServers.stop',
  'skillPlugins.install',
  'skillPlugins.uninstall',
  'textGeneration.chatTitle',
  'mcp.sync',
  'memoryActivity.install',
  'memoryActivity.uninstall',
  // What extensions run here: installed, trusted, switched on or off;
  // reviewed, installed, updated or removed from a marketplace or GitHub;
  // and a new extension project written on this disk.
  'extensionScaffold.create',
  'extensionScaffold.home',
  'extensionScaffold.target',
  'marketplace.install',
  'marketplace.installGithub',
  'marketplace.resolveGithub',
  'marketplace.uninstall',
  'marketplace.update',
  'marketplace.verify',
  'module.install',
  'module.reportRegistry',
  'module.setEnabled',
  'module.setTrust',
  'module.uninstall',
  'conversationImport.import',
  'conversationImport.scan',
  'launchSettings.changed',
  'launchSettings.get',
  'launchSettings.migrate',
  'launchSettings.update',
  'providers.signIn',
  'providers.signInCancel',
  'providers.signInPaste',
  'providers.signInStart',
  'providers.signInWait',
  'pullRequests.link',
  'pullRequests.noteWork',
  'pullRequests.noteToolCall',
  // A chat's Create PR: the forge, the remote and the drafting CLI with this machine's credentials.
  'pullRequests.createState',
  'pullRequests.draft',
  'pullRequests.draftCancel',
  'pullRequests.push',
  'pullRequests.create',
  'session.terminalHandoff',
  // Every terminal method and stream: a terminal is a shell on this machine.
  ...(Object.keys(STUDIO_TERMINALS_METHODS) as StudioMethod[]),
  ...(Object.keys(STUDIO_TERMINALS_TOPICS) as StudioTopic[]),
  'usage.report',
  // Git that moves a branch, rewrites history or discards work.
  'git.revertPaths',
  'git.switchBranch',
  'git.mergeRef',
  'git.rebase',
  'git.cherryPick',
  'git.revertCommit',
  'git.resetToCommit',
  'git.deleteBranch',
  'git.renameBranch',
  'git.continueOperation',
  'git.abortOperation',
  'git.stashApply',
  'git.stashDrop',
  'git.checkoutCommit',
  'git.checkoutCommitAsBranch',
  'git.tagCommit',
  // Git that reaches a remote with this machine's credentials.
  'git.push',
  'git.fetch',
  'git.pullWithStash',
  // The worktrees agents run in.
  'git.pruneWorktrees',
  'git.unlockAgentWorktree',
  // The GitHub account Studio holds.
  'github.tokenStatus',
  'github.setToken',
  'github.clearToken',
  'github.listRepos',
  'github.listOwners',
  'github.clone',
  'github.cancelClone',
  'github.newProject',
  'github.cloneProgress',
  // Where this machine publishes agents' pages: the setting and the token it
  // holds, a set-up that signs in to the host, and the person's set-up question.
  'artifacts.settings',
  'artifacts.setUp',
  'artifacts.answerSetupQuestion',
  'artifacts.setupQuestions',
  // The pool of worktrees Studio's agents run in, and the agents' worktrees.
  'worktrees.poolSnapshot',
  'worktrees.poolSettings',
  'worktrees.setPoolSettings',
  'worktrees.inventory',
  'worktrees.poolAction',
  'worktrees.removeOther',
  'worktrees.installs',
  'worktrees.cancelInstall',
  'worktrees.create',
  'worktrees.restore',
  'worktrees.remove',
  'worktrees.cleanupAgents',
  'worktrees.poolChanged',
  'worktrees.installChanged',
  // A project's backlog by its folder on this machine.
  'backlog.location',
  'backlog.setRoot',
  'backlog.ensureRecords',
  'backlog.ensureIds',
  'backlog.edit',
  'backlog.createEpic',
]

const entries = (): Array<[StudioMethod | StudioTopic, StudioAccess, 'method' | 'topic']> => [
  ...(Object.keys(STUDIO_METHODS) as StudioMethod[]).map(
    (name) => [name, STUDIO_METHOD_ACCESS[name], 'method'] as [StudioMethod, StudioAccess, 'method'],
  ),
  ...(Object.keys(STUDIO_TOPICS) as StudioTopic[]).map(
    (name) => [name, STUDIO_TOPIC_ACCESS[name], 'topic'] as [StudioTopic, StudioAccess, 'topic'],
  ),
]
const allows = (grant: { owner: boolean; scopes: string[] }, name: string, kind: 'method' | 'topic') =>
  kind === 'method' ? studioGrantAllows(grant, name) : studioGrantAllowsTopic(grant, name)

test('only what runs a program or a terminal here, records an agent’s own work, or reads the agents’ own logs and session files, is an owner’s, each with its reason', () => {
  const held = entries()
    .filter(([, access]) => 'permissions' in access && access.owner !== undefined)
    .map(([name]) => name)
    .sort()
  assert.deepEqual(held, [...OWNER_ONLY].sort())
  for (const [name, access] of entries())
    if ('permissions' in access && access.owner !== undefined)
      assert.ok(typeof access.owner === 'string' && access.owner.length > 20, `${name} says why it is an owner's`)
})

test('an owner reaches every method and topic not held to Studio’s own windows', () => {
  for (const [name, access, kind] of entries())
    assert.equal(allows(OWNER, name, kind), 'permissions' in access, `${name} for an owner`)
})

test('a paired client holding every scope reaches all but the owner’s, by its scopes alone', () => {
  for (const [name, access, kind] of entries()) {
    const expected = 'permissions' in access && access.owner === undefined
    assert.equal(allows(PAIRED, name, kind), expected, `${name} for a paired client`)
  }
})

test('a read-only client follows chats and is refused every method that needs more', () => {
  for (const [name, access, kind] of entries()) {
    const expected =
      'permissions' in access &&
      access.owner === undefined &&
      access.permissions.every((permission) => permission === 'conversation:read')
    assert.equal(allows(READ_ONLY, name, kind), expected, `${name} for a read-only client`)
  }
  // The reads a follower needs are among them.
  for (const method of ['conversation.list', 'conversation.loadEarlier', 'conversation.turnDiff', 'session.list'])
    assert.equal(studioGrantAllows(READ_ONLY, method), true, method)
  assert.equal(studioGrantAllowsTopic(READ_ONLY, 'conversation.events'), true)
  for (const method of ['session.send', 'conversation.revert', 'providers.setSecret', 'files.write'])
    assert.equal(studioGrantAllows(READ_ONLY, method), false, method)
})

test('a revoked client reaches only what needs no grant at all', () => {
  for (const [name, access, kind] of entries()) {
    const expected = 'permissions' in access && access.owner === undefined && access.permissions.length === 0
    assert.equal(allows(REVOKED, name, kind), expected, `${name} for a revoked client`)
  }
  assert.equal(studioGrantAllows(REVOKED, 'server.ping'), true)
  assert.equal(studioGrantAllows(REVOKED, 'conversation.list'), false)
})

test('a provider’s key is Settings, written only under settings:write; an approval rule is revoked by whoever drives the chats', () => {
  for (const method of ['providers.setSecret', 'providers.clearSecret'] as const)
    assert.deepEqual(STUDIO_METHOD_ACCESS[method], { permissions: ['settings:write'] }, method)
  assert.equal(studioGrantAllows({ owner: false, scopes: ['conversation:operate'] }, 'providers.setSecret'), false)
  assert.equal(studioGrantAllows({ owner: false, scopes: ['settings:write'] }, 'providers.setSecret'), true)
  // Revoking only makes the chats ask again, so it needs no more than driving them.
  assert.deepEqual(STUDIO_METHOD_ACCESS['conversation.revokeApprovalRule'], { permissions: ['conversation:operate'] })
  assert.equal(
    studioGrantAllows({ owner: false, scopes: ['conversation:read'] }, 'conversation.revokeApprovalRule'),
    false,
  )
})

test('what only the desktop’s own shell may call is an owner’s too, so every other refusal reads it', () => {
  const shellOnly = (Object.keys(STUDIO_METHODS) as StudioMethod[]).filter((name) => STUDIO_METHODS[name].shell)
  assert.deepEqual(shellOnly.sort(), [
    'environment.deviceTicket',
    'environment.revokeWindow',
    'environment.windowTicket',
  ])
  for (const name of shellOnly) {
    assert.ok((STUDIO_METHODS[name].shell ?? '').length > 20, `${name} says why it is the shell's`)
    assert.ok(STUDIO_METHODS[name].owner, `${name} is an owner's`)
  }
})
