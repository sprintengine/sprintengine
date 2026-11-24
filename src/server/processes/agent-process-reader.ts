import { execFile } from 'node:child_process'
import { readdir, readFile, readlink } from 'node:fs/promises'

import {
  parseLsofCwds,
  parseLsofListeners,
  parseMacProcesses,
  parseProcStat,
  identityFromEnvironment,
  type ProcessSnapshot,
  type ScannedProcess,
} from './agent-process-scan'

// The reads behind the `processes` domain, on the machine Studio runs on:
// this user's processes with the identity in their environment, the TCP ports
// they listen on, and a row's folder. macOS reads `ps` (its `-E` prints a
// process's environment after its command line) and `lsof`; Linux reads
// `/proc`, with `lsof` for ports where it is installed and the socket tables
// where it is not. Windows has no way to read another process's environment
// without reaching into it, so there is no reader there (null), and the
// domain says the list is not available yet.

export type ProcessReader = {
  /** Throws when the machine could not be read. */
  read(): Promise<ProcessSnapshot>
  /** Each pid's folder, where it could be read; a pid missing has none known. */
  cwds(pids: readonly number[]): Promise<Map<number, string>>
}

/** `missing`: the program is not installed. */
export type Run = (command: string, args: string[]) => Promise<{ stdout: string; failed: boolean; missing?: boolean }>

const runCommand: Run = (command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: 5_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout) =>
        resolve({
          stdout: String(stdout ?? ''),
          failed: error !== null,
          ...((error as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? { missing: true } : {}),
        }),
    )
  })

/**
 * The ports `uid`'s processes listen on; null where lsof is not installed.
 * lsof exits 1 when nothing matched, which is an empty answer, not a failure.
 */
async function listeners(run: Run, uid: number): Promise<Map<number, number[]> | null> {
  const answer = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-u', String(uid), '-Fpn'])
  if (answer.missing) return null
  return parseLsofListeners(answer.stdout)
}

export function createMacProcessReader(uid: number, run: Run = runCommand): ProcessReader {
  return {
    async read() {
      const [withEnv, argsOnly, ports] = await Promise.all([
        run('ps', ['-E', '-ww', '-axo', 'uid=,pid=,ppid=,pgid=,rss=,lstart=,command=']),
        run('ps', ['-ww', '-axo', 'pid=,command=']),
        listeners(run, uid),
      ])
      if (withEnv.failed || argsOnly.failed) throw new Error('ps could not list this machine’s processes.')
      return {
        processes: parseMacProcesses(withEnv.stdout, argsOnly.stdout, uid),
        listeners: ports ?? new Map(),
        scannedAt: Date.now(),
      }
    },
    async cwds(pids) {
      if (pids.length === 0) return new Map()
      const answer = await run('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')])
      return parseLsofCwds(answer.stdout)
    },
  }
}

// ── Linux ───────────────────────────────────────────────────────────────────

/** Clock ticks per second for `/proc/<pid>/stat`'s start time: 100 on every Linux Studio runs on. */
const CLOCK_TICKS = 100

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** `/proc/net/tcp{,6}`: the inode of each listening socket, and its port. */
export function parseProcNetListeners(table: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/u)
    // local_address is `HEX_IP:HEX_PORT`; state 0A is LISTEN; inode is field 9.
    if (fields.length < 10 || fields[3] !== '0A') continue
    const port = Number.parseInt(fields[1]!.split(':')[1] ?? '', 16)
    if (Number.isInteger(port) && port > 0) out.set(fields[9]!, port)
  }
  return out
}

export function createLinuxProcessReader(uid: number, run: Run = runCommand, proc = '/proc'): ProcessReader {
  const socketPorts = async (pids: readonly number[]): Promise<Map<number, number[]>> => {
    const byInode = new Map<string, number>()
    for (const table of ['tcp', 'tcp6']) {
      const text = await readText(`${proc}/net/${table}`)
      if (text) for (const [inode, port] of parseProcNetListeners(text)) byInode.set(inode, port)
    }
    const out = new Map<number, number[]>()
    if (byInode.size === 0) return out
    for (const pid of pids) {
      let fds: string[]
      try {
        fds = await readdir(`${proc}/${pid}/fd`)
      } catch {
        continue
      }
      for (const fd of fds) {
        const target = await readlink(`${proc}/${pid}/fd/${fd}`).catch(() => '')
        const inode = /^socket:\[(\d+)\]$/u.exec(target)?.[1]
        const port = inode ? byInode.get(inode) : undefined
        if (port === undefined) continue
        const ports = out.get(pid) ?? []
        if (!ports.includes(port)) ports.push(port)
        out.set(pid, ports)
      }
    }
    for (const ports of out.values()) ports.sort((a, b) => a - b)
    return out
  }

  return {
    async read() {
      const bootLine = /^btime\s+(\d+)$/mu.exec((await readText(`${proc}/stat`)) ?? '')
      if (!bootLine) throw new Error('/proc could not be read.')
      const bootSeconds = Number(bootLine[1])
      const entries = (await readdir(proc)).filter((name) => /^\d+$/u.test(name))
      const processes: ScannedProcess[] = []
      for (const name of entries) {
        const status = await readText(`${proc}/${name}/status`)
        const owner = status ? /^Uid:\s+(\d+)/mu.exec(status)?.[1] : undefined
        if (owner === undefined || Number(owner) !== uid) continue
        const stat = parseProcStat((await readText(`${proc}/${name}/stat`)) ?? '')
        if (!stat) continue
        const cmdline = ((await readText(`${proc}/${name}/cmdline`)) ?? '').replace(/\0+$/u, '').split('\0').join(' ')
        const environ = (await readText(`${proc}/${name}/environ`)) ?? ''
        const rssKb = Number(/^VmRSS:\s+(\d+)/mu.exec(status ?? '')?.[1] ?? 0)
        processes.push({
          pid: Number(name),
          ppid: stat.ppid,
          pgid: stat.pgid,
          startedAt: Math.floor(bootSeconds + stat.startTicks / CLOCK_TICKS) * 1000,
          rssBytes: rssKb * 1024,
          command: cmdline,
          identity: identityFromEnvironment(environ),
          ...(stat.state === 'Z' || cmdline === '' ? { defunct: true } : {}),
        })
      }
      const ports = await listeners(run, uid)
      return {
        processes,
        listeners:
          ports ??
          (await socketPorts(
            processes.filter((entry) => entry.identity !== null || entry.ppid > 1).map((entry) => entry.pid),
          )),
        scannedAt: Date.now(),
      }
    },
    async cwds(pids) {
      const out = new Map<number, string>()
      for (const pid of pids) {
        const cwd = await readlink(`${proc}/${pid}/cwd`).catch(() => null)
        if (cwd) out.set(pid, cwd)
      }
      return out
    },
  }
}

/** This machine's reader; null where processes cannot be read yet (Windows). */
export function createProcessReader(platform: NodeJS.Platform = process.platform): ProcessReader | null {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (uid === null) return null
  if (platform === 'darwin') return createMacProcessReader(uid)
  if (platform === 'linux') return createLinuxProcessReader(uid)
  return null
}
