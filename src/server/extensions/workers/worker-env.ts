// The environment an extension's worker process starts with: an allow-list,
// so nothing the person's shell or Studio itself exported reaches third-party
// code. Studio's own variables (`SPRINTENGINE_*`: its tokens, its sockets, its
// data folder), the agents' variables and every credential a shell exports
// (`GITHUB_TOKEN`, cloud keys, `NODE_OPTIONS`) are left out by not being on it.

const WORKER_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  // Where the session's sockets are, not credentials: a git credential helper
  // and ssh-agent connect through them, so a worker's git over SSH works.
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'SSH_AUTH_SOCK',
  // Node and libuv on Windows look up DLLs and the system root through these.
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
] as const

export function buildWorkerEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {}
  // Windows names are case-insensitive; folding on POSIX would let a
  // lower-case `path` someone set stand in for `PATH`.
  const windows = new Map<string, string>()
  if (platform === 'win32') {
    for (const [key, value] of Object.entries(baseEnv))
      if (typeof value === 'string') windows.set(key.toUpperCase(), value)
  }
  for (const key of WORKER_ENV_ALLOWLIST) {
    const value = platform === 'win32' ? windows.get(key) : baseEnv[key]
    if (value !== undefined) env[key === 'SYSTEMROOT' ? 'SystemRoot' : key] = value
  }
  // Electron (Chromium) marks the session bus `disabled:` in its own
  // environment; a child keeping that mark never finds the real bus at
  // `$XDG_RUNTIME_DIR/bus`. A real address is kept.
  if (env.DBUS_SESSION_BUS_ADDRESS === 'disabled:') delete env.DBUS_SESSION_BUS_ADDRESS
  // A worker has no terminal: a git credential prompt would hang it, or take
  // the terminal Studio was started from.
  env.GIT_TERMINAL_PROMPT = '0'
  // Under Electron the fork runs Electron's own binary; this makes it Node.
  env.ELECTRON_RUN_AS_NODE = '1'
  return env
}
