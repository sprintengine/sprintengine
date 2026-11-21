// The permissions an extension may ask for: a closed vocabulary. extension.json
// refuses a name that is not here. Pure (no Node APIs, no values imported from
// index), so the manifest validator and the index can both import it.
//
// Studio checks every call an extension makes into it against two things: the
// permissions the person approved for the extension, and what whoever set the
// call off may do themselves (the person at this machine, a paired device, an
// agent). A call goes through only when both hold. Studio-wide reads share
// their names with the Studio protocol's permissions (`workspace:read`,
// `conversation:read`, …); the rest name what is the extension's own.
//
// A permission says what an extension may ask Studio to do. A `ui`
// extension's code runs isolated in a frame, so what it may ask is all it can
// do. A `worker` extension's code runs on this machine with full access, and
// the approval says so.

export const EXTENSION_PERMISSIONS = [
  // ── Studio's own data, as any client reads it ──
  // The workspaces and their folders, branches and remotes; whether a skill is
  // in one.
  'workspace:read',
  // Make a workspace, and put one of Studio's skills in one.
  'workspace:operate',
  // Every chat on this machine, read only.
  'conversation:read',
  'backlog:read',
  // Create Backlog items and change their status, triage, links and metadata.
  'backlog:operate',
  // The agent runtimes a chat can run on.
  'providers:read',
  // Token usage of every agent session on this machine.
  'usage:read',
  // The files inside the person's workspaces, through Studio (`files.*`):
  // never outside a workspace's folder, and never through a link out of it.
  'workspace-files:read',
  'workspace-files:write',
  // ── What is the extension's own ──
  // Its own stored data.
  'storage:own',
  // The values of its own Settings section.
  'settings:own',
  // Keys it stores, which Studio sends only to the sites it named with them.
  'secrets:own',
  // Rows in the bell.
  'notifications:show',
  // Start chats of its own, drive them and read them.
  'conversation:own',
  // Let those chats run without asking (`bypass`), and with tools the agent
  // uses without asking (`allowedTools`).
  'conversation:bypass',
  // Open a chat with a message drafted for the person to read and send.
  'chat:draft',
  // Scheduled agents of its own.
  'schedules:own',
  // Prompts to the person's own agent CLI, with no chat.
  'agents:generate',
  // Background agents of its own in a workspace.
  'agents:companion',
  // The GitHub API, with the person's sign-in.
  'github:api',
  // Tools that agents reach through Studio's MCP server.
  'tools:contribute',
] as const

export type ExtensionPermission = (typeof EXTENSION_PERMISSIONS)[number]

/** Whether a value names a permission extension.json may ask for. */
export function isExtensionPermission(value: unknown): value is ExtensionPermission {
  return (EXTENSION_PERMISSIONS as readonly unknown[]).includes(value)
}
