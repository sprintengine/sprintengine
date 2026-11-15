import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

// Where a container runs, and how Studio runs a command there
// (docs/design/container-chats.md). A container can run on any machine Studio
// drives: this computer, or an SSH machine the person saved. Either way the
// work is a short POSIX shell script run on that machine, which is how one
// piece of code builds the image, makes, starts and deletes a container, and
// clones into it, wherever Docker is:
//
//   this computer   /bin/sh -c <script>
//   an SSH machine  ssh … -- <machine> sh -c '<script>'   (the person's own ssh)
//
// A container's own exec channel, the one its Studio server's relay speaks
// over, is such a script too: `docker exec -i <container> sh -s` in place of
// an SSH machine's `sh -s`. Every value put into a script is quoted with
// `shellQuote`, and only names Studio minted (container and image names) are
// ever spelled bare.

/** One shell script running on a container's host: stdin, stdout and stderr are the script's. */
export type HostProcess = ChildProcessWithoutNullStreams

/** Runs `script` with POSIX `sh` on the host; `interactive` lets an SSH machine ask through Studio's dialogs. */
export type HostRunner = (
  script: string,
  options?: {
    interactive?: boolean
    /**
     * A line the script prints once it has read all of itself: what the
     * caller writes to stdin is held until then, so a shell reading its script
     * from stdin never swallows the bytes meant for the command it becomes.
     */
    holdUntil?: string
  },
) => HostProcess

/** `value` as one word for a POSIX shell: single-quoted, with each `'` closed, escaped and reopened. */
export function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('A shell word cannot carry a NUL byte.')
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

/**
 * The directories Docker's command is looked for in on this computer, after
 * the PATH the app was given: an app opened from the Dock has only the
 * system's, and Docker's CLI is Homebrew's (Colima), Docker Desktop's, or a
 * package's.
 */
export function dockerSearchPath(
  basePath: string | undefined,
  options: { platform?: NodeJS.Platform; home?: string; loginPath?: string | null } = {},
): string {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const extra =
    platform === 'darwin'
      ? [
          '/opt/homebrew/bin',
          '/usr/local/bin',
          join(home, '.docker', 'bin'),
          '/Applications/Docker.app/Contents/Resources/bin',
        ]
      : platform === 'linux'
        ? ['/usr/local/bin', '/usr/bin', '/home/linuxbrew/.linuxbrew/bin']
        : []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of [...(options.loginPath ?? '').split(delimiter), ...(basePath ?? '').split(delimiter), ...extra]) {
    if (!entry || seen.has(entry)) continue
    seen.add(entry)
    out.push(entry)
  }
  return out.join(delimiter)
}

/** This computer's runner: `/bin/sh -c`, with Docker's usual homes on PATH. */
export function localHostRunner(
  options: {
    env?: NodeJS.ProcessEnv
    loginPath?: () => string | null
    /** Add Docker's usual homes to PATH (the default); a suite that stands its own `docker` in turns it off. */
    searchPath?: boolean
  } = {},
): HostRunner {
  return (script) => {
    const env = { ...(options.env ?? process.env) }
    if (options.searchPath !== false)
      env.PATH = dockerSearchPath(env.PATH, { loginPath: options.loginPath?.() ?? null })
    const child = spawn('/bin/sh', ['-c', script], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    child.stdin.on('error', () => undefined)
    return child
  }
}

/**
 * What an SSH machine's `sh -s` is sent for `script`: the script inside one
 * compound command, so the shell has parsed all of it before any of it runs
 * (the SSH bootstrap's rule, phase 8 spec E2). Sent on stdin rather than as a
 * `sh -c '…'` line, which a csh login shell refuses for its newlines.
 */
export function sshScriptBody(script: string): string {
  return `{\n${script}\n}\n`
}

/**
 * The child with its stdin swapped for one that holds every write until
 * `marker` has been printed on stdout. The script itself is written first,
 * straight to the real stdin.
 */
export function holdStdinUntil(child: HostProcess, marker: string): HostProcess {
  const real = child.stdin
  const held = new PassThrough()
  let seen = ''
  const watch = (chunk: Buffer) => {
    seen = (seen + chunk.toString('utf8')).slice(-4096)
    if (!seen.split('\n').some((line) => line.replace(/\r$/u, '') === marker)) return
    child.stdout.off('data', watch)
    held.pipe(real)
  }
  child.stdout.on('data', watch)
  held.on('error', () => undefined)
  Object.defineProperty(child, 'stdin', { value: held, configurable: true, writable: true })
  return child
}

export type HostResult = { code: number | null; stdout: string; stderr: string }

/**
 * Run `script` on a host to the end: its output and exit code. `input` is
 * written to its stdin, which is then closed. Rejects only when the process
 * could not be started; a script that fails resolves with its code.
 */
export function runOnHost(
  run: HostRunner,
  script: string,
  options: { input?: Buffer | string; timeoutMs?: number; interactive?: boolean } = {},
): Promise<HostResult> {
  return new Promise((resolve, reject) => {
    let child: HostProcess
    try {
      child = run(script, { interactive: options.interactive ?? false })
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill()
        }, options.timeoutMs)
      : null
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-1024 * 1024)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-64 * 1024)
    })
    child.once('error', (error) => {
      if (timer) clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: timedOut ? null : code, stdout, stderr: timedOut ? `${stderr}\nTimed out.` : stderr })
    })
    if (options.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
  })
}
