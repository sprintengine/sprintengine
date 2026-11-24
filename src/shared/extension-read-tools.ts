// The two agent tools that read which extensions a Studio runs:
// `extension.list` and `extension.status` (automation-tools.ts). They reach a
// paired device under its workspace scope, and a WSL agent through the relay,
// as the workspace list does. The rest of the `extension.*` family makes and
// explains extension projects on this machine's disk, for an agent working
// here, and goes nowhere else.
export const EXTENSION_READ_TOOLS: ReadonlySet<string> = new Set(['extension.list', 'extension.status'])
