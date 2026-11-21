import type { MainHost } from '@sprintengine/extension-sdk'

// Tools on Studio's MCP server, which every agent in every workspace is
// connected to, served from the worker's `activate` (src/main.ts). Each one is
// declared in extension.json (`contributes.mcpTools`) with what agents are
// told it does and its access; a tool served here that is not declared there
// is refused. Needs the "mcp:tools" permission.
//
// Tool names are a public contract: they start with the extension id, and
// stay stable.
export function registerTools(studio: MainHost): void {
  studio.registerMcpTools([
    {
      name: '{{toolPrefix}}_about',
      description: 'Say which extension this is.',
      inputSchema: { type: 'object', properties: {} },
      mutates: false,
      handler: async () => ({
        content: [{ type: 'text', text: `{{displayName}} (${studio.moduleId}).` }],
        structuredContent: { extension: studio.moduleId },
      }),
    },
  ])
}
