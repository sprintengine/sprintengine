// The permissions an extension's extension.json asks for, as the person reads
// them when they approve it.
//
// The vocabulary is the SDK's (packages/extension-sdk/src/permissions.ts), so
// the app and the `sprintengine-extension` CLI validate a manifest the same
// way. Studio checks every call an extension makes into it against what the
// person approved and against what whoever set the call off may do
// (main/module-host/extension-host-gate.ts). A `ui` extension's code runs
// isolated in sandboxed frames, so what it is allowed is all it can do. A
// `worker` extension's code runs on this machine with full access, and the
// approval says so in those words (`extensionApprovalCopy`).
//
// See docs/extension-authors/permissions.md for the author-facing reference.

import { isExtensionPermission } from '../../../packages/extension-sdk/src/permissions'
import type { ExtensionTier } from '../../../packages/extension-sdk/src/manifest-schema'

export {
  EXTENSION_PERMISSIONS,
  isExtensionPermission,
  type ExtensionPermission,
} from '../../../packages/extension-sdk/src/permissions'

/** A scope a signed package's plugin.json lists: shown as it is, never checked. */
export type CapabilityPermission = string

// Plain, sentence-case descriptions for the approval: what the person allows.
const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  'workspace:read': 'See your workspaces, their folders, branches and remotes',
  'workspace:operate': 'Make workspaces and put Studio’s skills in them',
  'conversation:read': 'Read every chat on this machine, including what you and the agents wrote (broad)',
  'backlog:read': 'Read Backlog items',
  'backlog:operate': 'Create Backlog items and change their status, triage, links and metadata',
  'providers:read': 'See which agents a chat can run on',
  'usage:read': 'See token usage and cost of every agent session on this machine',
  'workspace-files:read': 'Read the files in your workspaces’ folders',
  'workspace-files:write':
    'Change and create files in your workspaces’ folders, which can run code as you (full access)',
  'storage:own': 'Save its own data',
  'settings:own': 'Read the values of its own Settings section',
  'secrets:own': 'Store API keys and send them to the sites it names (the key is never shown back to the extension)',
  'notifications:show': 'Show notifications in the bell',
  'conversation:own': 'Start chats of its own with your agents, send them messages, read them and stop them',
  'conversation:bypass': 'Let the agents in its chats edit files and run commands without asking you first',
  'chat:draft': 'Open a chat with a message drafted for you to read and send',
  'schedules:own': 'Schedule agents of its own that start a chat on a timer',
  'agents:generate': 'Send prompts to your AI models in the background, without opening a chat',
  'agents:companion': 'Run its own background agents inside a workspace',
  'github:api': 'Use your GitHub sign-in to call the GitHub API (the token is never shown to the extension)',
  'tools:contribute': 'Add tools that agents in your workspaces can call',
  'terminals:send':
    'Type into your terminals and run commands: open terminals in your workspaces, type into the ones it opened and the ones in a workspace you have open, and close the ones it opened',
  'terminals:read': 'Read what your terminals show, which can include what commands print',
}

/** Whether a scope is one this version knows. */
export function isKnownCapabilityPermission(value: string): boolean {
  return isExtensionPermission(value)
}

// Broad: it reads what the person wrote in every chat, so the approval marks it.
const BROAD_CAPABILITY_PERMISSIONS: ReadonlySet<string> = new Set(['conversation:read'])

export function isBroadCapabilityPermission(value: string): boolean {
  return BROAD_CAPABILITY_PERMISSIONS.has(value)
}

// A human-readable line for the approval; unknown scopes are surfaced verbatim
// with a marker so the person can see exactly what was asked for.
export function describeCapabilityPermission(permission: string): string {
  return PERMISSION_DESCRIPTIONS[permission] ?? `Unrecognized permission: ${permission}`
}

/**
 * Permissions that amount to full access to the person's account however
 * isolated the code that holds them: a workspace's files include ones that run
 * code (a project's scripts, its tools' configuration), so changing them is
 * running code as the person.
 */
const FULL_ACCESS_PERMISSIONS: ReadonlySet<string> = new Set(['workspace-files:write'])

/** Whether an extension asking for these permissions has full access to the person's account. */
export function grantsFullAccess(permissions: readonly string[]): boolean {
  return permissions.some((permission) => FULL_ACCESS_PERMISSIONS.has(permission))
}

/**
 * What approving an extension of this tier, asking for these permissions,
 * means, in the words the approval says before anything else, and only what
 * this build enforces. A `ui` extension's code runs in sandboxed frames with
 * no network and no reach into the app, so it can do only what the person
 * allows, unless what it asks for is itself full access (`grantsFullAccess`).
 * A `worker` extension's code runs on this machine with full access; Studio
 * checks only the calls it makes into Studio.
 */
/** What an extension hands agents and chats that its approval has to speak to. */
export type ExtensionAgentReach = {
  /** It has a local (stdio) MCP server: a command the person's agents run on this machine. */
  localServers?: boolean
  /** It adds a model provider: an endpoint the key the person enters is sent to. */
  providers?: boolean
}

export function extensionApprovalCopy(
  tier: ExtensionTier,
  permissions: readonly string[] = [],
  agents: ExtensionAgentReach = {},
): string {
  // Whatever its tier, what it hands agents is said too: a local MCP server
  // runs with the agent's own access, which is the person's.
  const reach = [
    ...(agents.localServers
      ? [
          'Your agents will run its local MCP servers on this machine, with full access to your account: read each command, its arguments and its environment below. An update that changes them, or the files they run, asks again.',
        ]
      : []),
    ...(agents.providers
      ? ['Chats can use its model providers; a key you enter for one is sent only to the address shown below.']
      : []),
  ]
  if (tier === 'declarative' && reach.length > 0) return reach.join(' ')
  const base = tierApprovalCopy(tier, permissions)
  return reach.length > 0 ? `${base} ${reach.join(' ')}` : base
}

function tierApprovalCopy(tier: ExtensionTier, permissions: readonly string[]): string {
  if (tier === 'ui' && grantsFullAccess(permissions))
    return 'Its code runs isolated, but it asks to change the files in your workspaces, and a project’s files can run code: approving it gives it full access to your account on this machine.'
  switch (tier) {
    case 'content':
      return 'It only carries content, and runs nothing.'
    case 'declarative':
      return 'It adds commands, menu items and buttons to Studio that run Studio’s own actions. It runs no code of its own.'
    case 'ui':
      return 'Its code runs isolated and can do only what you allow below: it has no network of its own, and everything else goes through Studio, which checks every call.'
    case 'worker':
      return 'Its code runs on this machine with full access: your files, your programs, your network and your accounts. Studio checks the calls it makes into Studio against what you allow below; its own code is not limited.'
  }
}

// ── At-a-glance access ───────────────────────────────────────────────────────
//
// The sentences above are what the full approval reads. A list of extensions
// cannot afford a sentence per permission, so every known one also has a short
// title, and the ones that warrant a second look before approving — reach past
// the extension's own data, act as the person, or run unattended — are marked
// `care` with a "why" of six words or fewer. Settings → Extensions draws one
// warning glyph per `care` permission on a row and lists the titles on hover;
// its details and approval show the why. An unrecognized one always needs
// care: nothing here can say what it grants.

export type CapabilityAccess = {
  /** Short sentence-case title: "Reads all your chats". */
  title: string
  /** Warrants a second look before approving. */
  care: boolean
  /** Six words or fewer, for `care` permissions only. */
  why?: string
}

const CAPABILITY_ACCESS: Record<string, CapabilityAccess> = {
  // Needs care.
  'workspace:operate': { title: 'Makes workspaces', care: true, why: 'Writes skills into your projects' },
  'conversation:read': { title: 'Reads all your chats', care: true, why: 'Every chat on this machine' },
  'conversation:own': { title: 'Runs chats with your agents', care: true, why: 'Starts, messages and stops chats' },
  'conversation:bypass': {
    title: 'Lets agents act without asking',
    care: true,
    why: 'Edits and commands without approval',
  },
  'github:api': { title: 'Uses your GitHub sign-in', care: true, why: 'Calls GitHub as you' },
  'secrets:own': { title: 'Holds your API keys', care: true, why: 'Sends them to sites it names' },
  'usage:read': { title: 'Sees your usage and cost', care: true, why: 'Every agent session on this machine' },
  'backlog:operate': { title: 'Changes Backlog items', care: true, why: 'Creates and edits your items' },
  'terminals:send': { title: 'Types into your terminals', care: true, why: 'Runs commands as you' },
  'terminals:read': { title: 'Reads your terminals', care: true, why: 'Sees what your commands print' },
  'workspace-files:write': {
    title: 'Changes your project files',
    care: true,
    why: 'Full access: project files run code',
  },
  // Standard.
  'workspace:read': { title: 'Sees workspaces and git state', care: false },
  'workspace-files:read': { title: 'Reads your project files', care: false },
  'backlog:read': { title: 'Reads the Backlog', care: false },
  'providers:read': { title: 'Sees your agents', care: false },
  'storage:own': { title: 'Saves its own data', care: false },
  'settings:own': { title: 'Reads its own settings', care: false },
  'notifications:show': { title: 'Shows notifications', care: false },
  'chat:draft': { title: 'Drafts messages for you to send', care: false },
  'schedules:own': { title: 'Schedules agents', care: false },
  'agents:generate': { title: 'Sends prompts to your models', care: false },
  'agents:companion': { title: 'Runs background agents', care: false },
  'tools:contribute': { title: 'Adds tools for agents', care: false },
}

/** The short title, care flag and why for one permission; unknown ones always need care. */
export function capabilityAccess(permission: string): CapabilityAccess {
  return (
    CAPABILITY_ACCESS[permission] ?? {
      title: `Unrecognized: ${permission}`,
      care: true,
      why: 'Not a permission this version knows',
    }
  )
}

/** A manifest's permissions split into those that need care and the rest, each in declared order. */
export function partitionCapabilityAccess(permissions: readonly string[]): {
  care: string[]
  standard: string[]
} {
  const care: string[] = []
  const standard: string[] = []
  for (const permission of permissions) {
    ;(capabilityAccess(permission).care ? care : standard).push(permission)
  }
  return { care, standard }
}

// The bundle permissions validator lives in the published SDK so the app and
// the `sprintengine-extension` CLI validate manifests identically; re-exported
// here for app code.
export { validateCapabilityPermissions } from '../../../packages/extension-sdk/src/manifest-validate'
