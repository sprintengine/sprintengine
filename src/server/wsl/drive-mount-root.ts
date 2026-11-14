import { readFileSync } from 'node:fs'

import { driveMountRootFromMounts, driveMountRootFromWslConf } from '../../shared/host-paths'

/**
 * Where this distribution mounts the Windows drives: what is mounted, else
 * what wsl.conf asks for; null when it mounts none. Only a server inside the
 * distribution can tell, so it says it: in its front door's `ready`, and in
 * its welcome (`StudioEnvironment.driveMountRoot`), for every client that
 * spells a drive path for it.
 */
export function readDriveMountRoot(read: (path: string) => string | null = readText): string | null {
  const mounts = read('/proc/mounts')
  const mounted = mounts ? driveMountRootFromMounts(mounts) : null
  return mounted ?? driveMountRootFromWslConf(read('/etc/wsl.conf'))
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
