#!/usr/bin/env node
// SprintEngine Studio's helper inside one WSL distribution.
//
// Main starts one of these per distribution, the first time anything needs
// that machine, as
//
//   wsl.exe -d <distro> --cd ~ --exec sh -s     (a script that execs:)
//   <node> ~/.local/share/sprintengine-studio/<version>/wsl-helper/helper.mjs --profile <id>
//
// and talks to it over that one process's stdin and stdout: newline-delimited
// JSON (`lib/frames.mjs`). It is the only channel between Windows and Linux, so
// the app needs no networking mode, no interop inside the distribution, and no
// port anywhere. The app's hooks, status line and OpenCode plugin report to
// the distribution's own Studio server, which relays them to the desktop
// (`src/server/wsl/agent-state-relay.ts`), and an agent's MCP bridge reaches
// that server's gateway (`src/server/wsl/wsl-launch-tokens.ts`), which also
// writes each launch's startup script and reads and ends the processes a
// session leaves, and builds the app's plugin copy its agent loads
// (`src/server/wsl/distribution-terminal-host.ts`), and runs git, says the
// home and watches git directories for the desktop
// (`src/server/wsl/distribution-machine.ts`). The helper answers main's
// questions about the distribution that are left: which CLIs are installed,
// and running a program.
//
// Lifetime. It exits when its stdin closes (main quit, crashed, or killed the
// `wsl.exe`), when main says `shutdown`, or on a signal, and on the way out it
// ends every process group it started. Main stops it about two minutes after
// its last request, so the VM can idle. Plain Node, no
// dependencies: it runs on the pinned Linux Node main installed next to it,
// never on the person's own.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createCliDetector } from './lib/cli-detect.mjs'
import { createLineDecoder, decodeFrame, encodeFrame, PROTOCOL_VERSION } from './lib/frames.mjs'
import { captureLoginEnv } from './lib/login-env.mjs'
import { checkRunRequest, childEnv, killAllChildren, runArgv } from './lib/run.mjs'

// A cap on main's frames, because a broken writer should end the helper rather
// than fill its memory.
const MAX_MAIN_LINE_BYTES = 4 * 1024 * 1024
const HELLO_TIMEOUT_MS = 30_000

const uid = typeof process.getuid === 'function' ? process.getuid() : -1
const helperDir = dirname(fileURLToPath(import.meta.url))
const appDir = dirname(helperDir)
let exiting = false
function send(frame) {
  if (exiting) return
  try {
    process.stdout.write(encodeFrame(frame))
  } catch {
    shutdown(0)
  }
}

process.stdout.on('error', () => shutdown(0))

let loginEnvPromise = null
const loginEnv = () => {
  loginEnvPromise ??= captureLoginEnv({ uid })
  return loginEnvPromise
}

const detector = createCliDetector({
  getEnv: loginEnv,
  onPathsChanged: () => send({ t: 'ev', event: 'pathsChanged' }),
})

async function shutdown(code) {
  if (exiting) return
  exiting = true
  killAllChildren()
  detector.close()
  process.exit(code)
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => void shutdown(0))

async function start(hello) {
  const profile = String(hello.profile ?? '')
  const home = process.env.HOME || homedir()
  // Read in the background now; the first CLI check or run waits on it.
  void loginEnv()
  return {
    uid,
    profile,
    home,
    arch: process.arch,
    nodePath: process.execPath,
    appDir,
  }
}

const methods = {
  ping: async () => ({}),
  async 'cli.detect'(params) {
    const requests = Array.isArray(params?.requests) ? params.requests : []
    return { results: await detector.detect(requests, { force: params?.force === true }) }
  },
  async run(params) {
    const problem = checkRunRequest(params ?? {})
    if (problem) throw new Error(problem)
    if (params.timeoutMs === null) throw new Error('run needs a deadline.')
    return runArgv({
      argv: params.argv,
      cwd: params.cwd,
      env: childEnv(await loginEnv(), params.env),
      timeoutMs: params.timeoutMs,
    })
  },
}

async function handleRequest(frame) {
  const method = methods[frame.method]
  if (!method) {
    send({ t: 'res', id: frame.id, error: { message: `Unknown method ${String(frame.method)}.` } })
    return
  }
  try {
    send({ t: 'res', id: frame.id, result: await method(frame.params) })
  } catch (error) {
    send({ t: 'res', id: frame.id, error: { message: String(error?.message ?? error) } })
  }
}

let greeted = false
const helloTimer = setTimeout(() => void shutdown(2), HELLO_TIMEOUT_MS)

async function handleFrame(frame) {
  if (!greeted) {
    if (frame.t !== 'hello') {
      void shutdown(2)
      return
    }
    greeted = true
    clearTimeout(helloTimer)
    if (frame.protocol !== PROTOCOL_VERSION) {
      send({ t: 'hello', ok: false, protocol: PROTOCOL_VERSION, error: 'protocol mismatch' })
      void shutdown(3)
      return
    }
    try {
      send({ t: 'hello', ok: true, protocol: PROTOCOL_VERSION, info: await start(frame) })
    } catch (error) {
      send({ t: 'hello', ok: false, protocol: PROTOCOL_VERSION, error: String(error?.message ?? error) })
      void shutdown(4)
    }
    return
  }
  if (frame.t === 'req' && Number.isInteger(frame.id)) void handleRequest(frame)
  else if (frame.t === 'shutdown') void shutdown(0)
}

const decoder = createLineDecoder({
  maxLineBytes: MAX_MAIN_LINE_BYTES,
  onLine(line) {
    const frame = decodeFrame(line)
    if (frame) void handleFrame(frame)
  },
  onOverflow: () => void shutdown(5),
})

process.stdin.on('data', (chunk) => decoder.push(chunk))
process.stdin.on('end', () => void shutdown(0))
process.stdin.on('close', () => void shutdown(0))
process.stdin.on('error', () => void shutdown(0))

// Said first, before anything is read: main sends its hello only after this
// line, because the shell that started us may otherwise have read part of it.
send({ t: 'boot', protocol: PROTOCOL_VERSION, pid: process.pid, version: readVersion() })

function readVersion() {
  try {
    return readFileSync(join(appDir, '.ready'), 'utf8').trim()
  } catch {
    return null
  }
}
