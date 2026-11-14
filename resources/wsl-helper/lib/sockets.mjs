// The helper's private runtime directory, where each session shell records
// its pid:
//
//   <runtime>/sprintengine/<profile>/sessions/    each session shell's pid file
//
// <runtime> is `$XDG_RUNTIME_DIR` when it is a directory this user owns and no
// one else can enter, else `/tmp/sprintengine-<uid>`. Every directory the
// helper creates is 0700: only this user can enter it.
//
// A directory someone else created first (a shared `/tmp`) is refused rather
// than used: the helper would otherwise keep its pid files where another user
// can replace them.

import { lstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const PROFILE = /^[A-Za-z0-9_-]{1,64}$/u

function ownedPrivateDir(path, uid) {
  try {
    const stats = lstatSync(path)
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false
    if (typeof uid === 'number' && stats.uid !== uid) return false
    return (stats.mode & 0o077) === 0
  } catch {
    return false
  }
}

/**
 * Creates `path` (0700) if it is missing, and checks it is ours and private
 * whether or not it was. Throws when it is not, naming the directory.
 */
export function ensurePrivateDir(path, uid) {
  try {
    mkdirSync(path, { mode: 0o700 })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  if (!ownedPrivateDir(path, uid)) {
    throw new Error(`${path} is not a private directory owned by this user; refusing to use it.`)
  }
  return path
}

/** The base under which the helper's per-profile directory goes. */
export function runtimeBase({ env, uid }) {
  const xdg = env.XDG_RUNTIME_DIR
  if (xdg && xdg.startsWith('/') && ownedPrivateDir(xdg, uid)) return join(xdg, 'sprintengine')
  return `/tmp/sprintengine-${uid}`
}

/** Creates (or checks) the per-profile socket directory, every level private. */
export function ensureSocketDir({ env, uid, profile, base }) {
  if (!PROFILE.test(profile)) throw new Error('The profile id is not a plain token.')
  const root = base ?? runtimeBase({ env, uid })
  ensurePrivateDir(root, uid)
  return ensurePrivateDir(join(root, profile), uid)
}
