// A local MCP server: newline-delimited JSON-RPC on stdin and stdout, the
// stdio transport every agent CLI speaks. Studio hands it to the person's
// agents as extension.json declares (`contributes.mcpServers`); each agent
// starts its own copy with `node <the extension's folder>/dist/server.mjs`.
//
// `handle` answers one message, so the tests drive it without a process;
// `serve` is the loop, which src/stdio.ts (the built entry) starts. Write only
// protocol messages to stdout: anything else breaks the agent's connection.
// Diagnostics go to stderr.

import { createInterface } from 'node:readline'

type Request = { jsonrpc: '2.0'; id?: number | string; method: string; params?: Record<string, unknown> }
type Response = { jsonrpc: '2.0'; id: number | string; result?: unknown; error?: { code: number; message: string } }

const TOOLS = [
  {
    name: 'count_words',
    description: 'Count the words in a text.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The text to count.' } },
      required: ['text'],
    },
  },
]

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/** The answer to one message, or null for a notification. */
export function handle(request: Request): Response | null {
  if (request.id === undefined) return null
  const reply = (result: unknown): Response => ({ jsonrpc: '2.0', id: request.id!, result })
  switch (request.method) {
    case 'initialize':
      return reply({
        protocolVersion: String(request.params?.protocolVersion ?? '2025-06-18'),
        capabilities: { tools: {} },
        serverInfo: { name: 'word-count', version: '0.1.0' },
      })
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: TOOLS })
    case 'tools/call': {
      const name = request.params?.name
      const text = (request.params?.arguments as { text?: unknown } | undefined)?.text
      if (name !== 'count_words' || typeof text !== 'string')
        return { jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'count_words takes { text }.' } }
      return reply({ content: [{ type: 'text', text: String(countWords(text)) }] })
    }
    default:
      return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `No method ${request.method}.` } }
  }
}

/** Answer every message on stdin, one line each, until stdin closes. */
export function serve(): void {
  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    if (!line.trim()) return
    let request: Request
    try {
      request = JSON.parse(line) as Request
    } catch {
      process.stderr.write('word-count: a line that is not JSON was ignored\n')
      return
    }
    const response = handle(request)
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`)
  })
}
