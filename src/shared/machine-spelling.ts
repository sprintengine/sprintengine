import { parseEnvironmentRoute } from '../../packages/studio-protocol/src/environment'
import { distroOfUncPath, toWslPath, wslToWindowsPath } from './host-paths'
import { isMachinePath, machinePath, parseMachinePath } from './machine-paths'

// How this computer spells the paths of another environment's machine, and
// how that machine spells them (design-wsl-ssh-direct PR 1d, PR 3c). A chat
// there keeps its folder in this computer's records as this computer spells
// it; its own Studio speaks plain Linux paths.
//
// - An SSH machine's path is `ssh://<id>/home/dev/repo` here
//   (machine-paths.ts), which names nothing on this computer, and
//   `/home/dev/repo` there.
// - A WSL distribution's path is the share Windows opens it by,
//   `\\wsl.localhost\Ubuntu\home\dev\repo` (or `\\wsl$\…`), or a Windows
//   drive the distribution mounts, `C:\code\repo`; there it is
//   `/home/dev/repo` or `/mnt/c/code/repo` (under the distribution's own
//   drive mount root, which only it can say).
//
// An `ssh://<id>/` string can only be a path there, so every string sent is
// read for one. A drive path can be words too, so a WSL machine's are read
// only where they are not a person's text (`guesses`).

export type MachineSpelling = {
  /** The route of the machine, which keys the clients made for it. */
  route: string
  /** A string this computer spells for that machine, as the machine spells it; null for any other string. */
  toMachine(value: string): string | null
  /** An absolute path there, as this computer spells it. */
  fromMachine(path: string): string
  /** Whether a string `toMachine` takes may also be words, so a person's text is left as written. */
  guesses: boolean
  /**
   * Why the machine cannot open a folder this computer names, in words, or
   * null: a member that names a folder (`MACHINE_PATH_MEMBERS`) is refused
   * rather than handed over as a name the machine would read as relative.
   */
  refusal(folder: string): string | null
}

/** Where a WSL distribution mounts Windows drives: its own word (`/mnt/` unless its wsl.conf says), or null for none. */
export type WslDriveMount = () => string | null | undefined

/** An SSH machine's spelling. */
function sshSpelling(id: string): MachineSpelling {
  return {
    route: `ssh:${id}`,
    toMachine: (value) => {
      const parsed = parseMachinePath(value)
      return parsed && parsed.id === id ? parsed.path : null
    },
    fromMachine: (path) => machinePath(id, path),
    guesses: false,
    refusal: () => null,
  }
}

/**
 * A WSL distribution's spelling. `driveMountRoot` is read on each use: it is
 * the distribution's own Studio's word, known once it has said it. Undefined
 * is the default root; null is a distribution that mounts no drives, whose
 * drive paths are left as they are.
 */
function wslSpelling(distro: string, driveMountRoot: WslDriveMount): MachineSpelling {
  const mount = () => {
    const root = driveMountRoot()
    return root ? { driveMountRoot: root } : {}
  }
  return {
    route: `wsl:${distro}`,
    toMachine: (value) => {
      const share = distroOfUncPath(value)
      if (share !== null) return share.toLowerCase() === distro.toLowerCase() ? toWslPath(value) : null
      if (!/^[A-Za-z]:[\\/]/u.test(value) || driveMountRoot() === null) return null
      return toWslPath(value, mount())
    },
    fromMachine: (path) => wslToWindowsPath(path, { distro, ...mount() }),
    guesses: true,
    refusal: (folder) => {
      const share = distroOfUncPath(folder)
      if (share !== null)
        return share.toLowerCase() === distro.toLowerCase() ? null : `${folder} is in WSL: ${share}, not in ${distro}.`
      if (folder.startsWith('\\\\')) return `${folder} is a network share, which WSL: ${distro} cannot open.`
      if (/^[A-Za-z]:[\\/]/u.test(folder) && driveMountRoot() === null)
        return `WSL: ${distro} mounts no Windows drives (automount is off in its /etc/wsl.conf), so a chat in ${folder} cannot run there.`
      return null
    },
  }
}

/** The spelling of the machine a route names, or null for a route whose paths are this computer's (or another desktop's). */
export function machineSpellingOf(
  route: string,
  driveMountRoot: WslDriveMount = () => undefined,
): MachineSpelling | null {
  const parsed = parseEnvironmentRoute(route)
  if (parsed?.kind === 'ssh') return sshSpelling(parsed.machine)
  if (parsed?.kind === 'wsl') return wslSpelling(parsed.distro, driveMountRoot)
  return null
}

/**
 * The route of the machine a path as this computer spells it is on, by the
 * path alone: an SSH machine's `ssh://<id>/…`, a WSL distribution's share
 * (`\\wsl.localhost\<distro>\…`, `\\wsl$\<distro>\…`). Null for anything
 * else, a Windows drive included: its files are this computer's to read.
 * Undefined for an `ssh://` path that names no machine.
 */
export function machineRouteOfPath(path: string): string | null | undefined {
  if (isMachinePath(path)) {
    const parsed = parseMachinePath(path)
    return parsed ? `ssh:${parsed.id}` : undefined
  }
  const distro = distroOfUncPath(path)
  return distro ? `wsl:${distro}` : null
}
