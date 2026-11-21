// The permissions an extension's extension.json asks for, as the person reads
// them when they approve it.
//
// The vocabulary is the SDK's (packages/extension-sdk/src/permissions.ts), so
// the app and the `sprintengine-extension` CLI validate a manifest the same
// way. Studio checks every call an extension makes into it against what the
// person approved and against what whoever set the call off may do
// (main/module-host/extension-host-gate.ts). A permission does not limit the
// extension's own code: an extension with code runs inside Studio with full
// access to this machine, and the approval says so in those words
// (`extensionApprovalCopy`).
//
// See docs/extension-authors/permissions.md for the author-facing reference.

import { isExtensionPermission } from '../../../packages/extension-sdk/src/permissions'
import type { ExtensionTier } from '../../../packages/extension-sdk/src/manifest-schema'

export {
  EXTENSION_PERMISSIONS,
  isExtensionPermission,
  type ExtensionPermission,
} from '../../../packages/extension-sdk/src/permissions'

/** A scope a plugin bundle's plugin.json lists: shown as it is, never checked. */
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
 * What approving an extension of this tier means, in the words the approval
 * says before anything else. An extension with code (`ui`, `worker`) runs
 * inside Studio with full access to this machine; Studio checks only the calls
 * it makes into Studio. That is true until its code runs in a frame or a
 * process of its own, and stays true for a worker.
 */
export function extensionApprovalCopy(tier: ExtensionTier): string {
  switch (tier) {
    case 'content':
      return 'It only carries content, and runs nothing.'
    case 'declarative':
      return 'It adds commands, menu items and buttons to Studio that run Studio’s own actions. It runs no code of its own.'
    case 'ui':
      return 'Its code runs inside Studio with full access to this machine: your files, your network and your accounts. Studio checks the calls it makes into Studio against what you allow below; its own code is not limited.'
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
  // Standard.
  'workspace:read': { title: 'Sees workspaces and git state', care: false },
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
