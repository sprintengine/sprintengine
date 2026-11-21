import { WorkspaceContextToken, type MainHost, type McpToolResult } from '@sprintengine/extension-sdk'

const text = (value: string): McpToolResult => ({ content: [{ type: 'text', text: value }] })
const failure = (value: string): McpToolResult => ({ content: [{ type: 'text', text: value }], isError: true })

// The worker: Studio loads extension/dist/main.cjs with require and calls
// `activate` with a `studio` for this extension. Tools it serves join Studio's
// MCP server, which every agent in every workspace is connected to, so an
// agent can call them by name. Needs the "tools:contribute" permission.
//
// Each tool is declared in extension.json (`contributes.mcpTools`): its name,
// what agents are told it does, and its access (`read` changes nothing). A
// tool served here that extension.json does not declare is refused, and the
// manifest's description and access are what agents see. Tool names are a
// public contract: they start with the extension id, and stay stable.
export function activate(studio: MainHost): void {
  studio.registerMcpTools([
    {
      name: '{{toolPrefix}}_word_count',
      description: 'Count the words, lines and characters in a piece of text.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The text to count.' } },
        required: ['text'],
      },
      mutates: false,
      handler: async (args) => {
        if (typeof args.text !== 'string') return failure('"text" must be a string.')
        const words = args.text.trim() === '' ? 0 : args.text.trim().split(/\s+/).length
        const lines = args.text === '' ? 0 : args.text.split('\n').length
        return {
          ...text(`${words} words, ${lines} lines, ${args.text.length} characters.`),
          structuredContent: { words, lines, characters: args.text.length },
        }
      },
    },
    {
      name: '{{toolPrefix}}_open_workspaces',
      description: 'List the workspaces open in SprintEngine Studio, with the folder each one works in.',
      inputSchema: { type: 'object', properties: {} },
      mutates: false,
      handler: async () => {
        // Resolved per call, when the tool runs.
        const workspaces = await studio.requireService(WorkspaceContextToken).list()
        if (workspaces.length === 0) return text('No workspaces are open.')
        return {
          ...text(workspaces.map((w) => `${w.name} — ${w.folderPath ?? '(no folder)'}`).join('\n')),
          structuredContent: { workspaces },
        }
      },
    },
  ])
}
