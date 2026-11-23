// The running Studio on this machine, as the authoring commands reach it: its
// gateway's local socket (the one Studio's own agents use, owner-only), over
// which they call the dev loop's tools (`extension.dev.*`,
// `visual.extension_shot`). Found from the discovery file in Studio's data
// folder: `--data-dir`, else $SPRINTENGINE_USER_DATA_DIR, else the desktop
// app's default.
//
// An agent Studio launched carries its launch token in its environment; it
// is presented here as Studio's own bridge presents it, so Studio knows the
// call is that agent's (an agent does not approve extensions).

import { existsSync, readFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { CliError } from './cli-output.js'

const INFO_FILENAMES = ['sprintengine-studio-mcp-info.json', 'automation-server-info.json']
const PROTOCOL_VERSION = '2025-06-18'
const CALL_TIMEOUT_MS = 60_000

function defaultDataDirs(): string[] {
  if (process.platform === 'darwin') {
    const base = join(homedir(), 'Library', 'Application Support')
    return [join(base, 'sprintengine-studio'), join(base, 'SprintEngine Studio')]
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    return appData ? [join(appData, 'sprintengine-studio'), join(appData, 'SprintEngine Studio')] : []
  }
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return [join(config, 'sprintengine-studio'), join(config, 'SprintEngine Studio')]
}

function infoPath(dataDir?: string): string | null {
  const dirs = dataDir
    ? [dataDir]
    : process.env.SPRINTENGINE_USER_DATA_DIR?.trim()
      ? [process.env.SPRINTENGINE_USER_DATA_DIR.trim()]
      : defaultDataDirs()
  for (const dir of dirs) for (const name of INFO_FILENAMES) if (existsSync(join(dir, name))) return join(dir, name)
  return null
}

const notRunning = (detail: string) =>
  new CliError('studio_unavailable', `No running SprintEngine Studio could be reached: ${detail}`, undefined, [
    'Start Studio on this machine, or pass --data-dir <its data folder> for another profile.',
  ])

export type StudioTools = {
  /** Call one of the gateway's tools; a refusal throws a CliError with its code. */
  call(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  close(): void
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

export async function connectStudio(options: { dataDir?: string } = {}): Promise<StudioTools> {
  const path = infoPath(options.dataDir)
  if (!path) throw notRunning('its discovery file was not found.')
  let socketPath: string
  try {
    const info = JSON.parse(readFileSync(path, 'utf8')) as { socketPath?: unknown }
    if (typeof info.socketPath !== 'string' || !info.socketPath) throw new Error('no socket named')
    socketPath = info.socketPath
  } catch (error) {
    throw notRunning(
      `its discovery file could not be read (${error instanceof Error ? error.message : String(error)}).`,
    )
  }
  const socket: Socket = await new Promise((resolve, reject) => {
    const opened = connect(socketPath)
    opened.once('connect', () => resolve(opened))
    opened.once('error', (error) => reject(notRunning(error.message)))
  })
  const pending = new Map<number, Pending>()
  let nextId = 1
  let buffer = ''
  let closed = false
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at).trim()
      buffer = buffer.slice(at + 1)
      if (!line) continue
      let message: { id?: unknown; result?: unknown; error?: { message?: string } }
      try {
        message = JSON.parse(line) as typeof message
      } catch {
        continue
      }
      if (typeof message.id !== 'number') continue
      const waiting = pending.get(message.id)
      if (!waiting) continue
      pending.delete(message.id)
      clearTimeout(waiting.timer)
      if (message.error)
        waiting.reject(new CliError('unavailable', message.error.message ?? 'Studio refused the call.'))
      else waiting.resolve(message.result)
    }
  })
  const lost = () => {
    closed = true
    for (const waiting of pending.values()) {
      clearTimeout(waiting.timer)
      waiting.reject(notRunning('the connection closed.'))
    }
    pending.clear()
  }
  socket.on('close', lost)
  socket.on('error', lost)
  const write = (message: Record<string, unknown>) =>
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  const request = (method: string, params: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS) =>
    new Promise<unknown>((resolve, reject) => {
      if (closed) return reject(notRunning('the connection closed.'))
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new CliError('unavailable', `Studio did not answer ${method} within ${timeoutMs / 1000}s.`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      write({ id, method, params })
    })

  const env = (name: string) => process.env[name]?.trim() ?? ''
  if (env('SPRINTENGINE_MCP_CHANNEL_TOKEN') || env('SPRINTENGINE_AGENT_ID'))
    write({
      method: 'sprintengine.studio/connect',
      params: {
        workspaceId: env('SPRINTENGINE_WORKSPACE_ID'),
        agentId: env('SPRINTENGINE_AGENT_ID'),
        agentName: env('SPRINTENGINE_AGENT_NAME'),
        cliId: env('SPRINTENGINE_AGENT_CLI'),
        ...(env('SPRINTENGINE_MCP_CHANNEL_TOKEN') ? { launchToken: env('SPRINTENGINE_MCP_CHANNEL_TOKEN') } : {}),
      },
    })
  await request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'sprintengine-extension', version: '1' },
  })
  write({ method: 'notifications/initialized' })

  return {
    async call(name, args, timeoutMs) {
      const result = (await request('tools/call', { name, arguments: args }, timeoutMs)) as {
        isError?: boolean
        structuredContent?: Record<string, unknown>
        content?: Array<{ text?: string }>
      }
      const structured = result?.structuredContent
      if (result?.isError) {
        const error = (structured?.error ?? {}) as { code?: string; message?: string; data?: Record<string, unknown> }
        throw new CliError(
          error.code ?? 'unavailable',
          error.message ?? result.content?.[0]?.text ?? `${name} failed.`,
          error.data,
        )
      }
      if (structured) return structured
      const text = result?.content?.[0]?.text
      try {
        return text ? (JSON.parse(text) as Record<string, unknown>) : {}
      } catch {
        return { text }
      }
    },
    close() {
      closed = true
      socket.end()
      socket.destroy()
    },
  }
}
