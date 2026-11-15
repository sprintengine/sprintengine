// SprintEngine Studio app-automation surface. The automation server
// (src/main/automation/) is a local-only MCP endpoint every Studio-launched
// agent is given. Reads answer from the server's authoritative stores (the
// workspace registry and the terminal runtime), and so do mutations: there is
// one lane, and no window is involved in any of them.
//
// A window reads its status over the Studio protocol (`gateway.status`,
// packages/studio-protocol/src/access.ts), where the shape is defined.

export type { AutomationServerStatus } from '../../packages/studio-protocol/src/public'
