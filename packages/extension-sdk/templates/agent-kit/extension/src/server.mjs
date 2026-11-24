// A local MCP server: newline-delimited JSON-RPC on stdin and stdout, the
// stdio transport every agent CLI speaks. Studio hands it to the person's
// agents as extension.json declares (`contributes.mcpServers`); each agent
// starts its own copy with `node <the extension's folder>/src/stdio.mjs`.
//
// Plain JavaScript, typed with JSDoc (`tsc` checks it): an agent runs it with
// whatever `node` it finds, which may predate Node's TypeScript support, and
// nothing builds it first.
//
// `handle` answers one message, so the tests drive it without a process;
// `serve` is the loop, which ./stdio.mjs starts. Write only protocol messages
// to stdout: anything else breaks the agent's connection. Diagnostics go to
// stderr.

import { createInterface } from 'node:readline'

/** @typedef {{ jsonrpc: '2.0', id?: number | string, method: string, params?: Record<string, unknown> }} Request */
/** @typedef {{ jsonrpc: '2.0', id: number | string, result?: unknown, error?: { code: number, message: string } }} Response */

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

/**
 * @param {string} text
 * @returns {number}
 */
export function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length
}

/**
 * The answer to one message, or null for a notification.
 * @param {Request} request
 * @returns {Response | null}
 */
export function handle(request) {
  const id = request.id
  if (id === undefined) return null
  /** @param {unknown} result @returns {Response} */
  const reply = (result) => ({ jsonrpc: '2.0', id, result })
  /** @param {number} code @param {string} message @returns {Response} */
  const refuse = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })
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
      const args = /** @type {{ text?: unknown } | undefined} */ (request.params?.arguments)
      if (name !== 'count_words' || typeof args?.text !== 'string') return refuse(-32602, 'count_words takes { text }.')
      return reply({ content: [{ type: 'text', text: String(countWords(args.text)) }] })
    }
    default:
      return refuse(-32601, `No method ${request.method}.`)
  }
}

/** Answer every message on stdin, one line each, until stdin closes. */
export function serve() {
  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    if (!line.trim()) return
    /** @type {Request} */
    let request
    try {
      request = JSON.parse(line)
    } catch {
      process.stderr.write('word-count: a line that is not JSON was ignored\n')
      return
    }
    const response = handle(request)
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`)
  })
}
