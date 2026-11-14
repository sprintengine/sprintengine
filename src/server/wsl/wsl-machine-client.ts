import type { WslMachineAccess } from '../../main/hosts/wsl-host'
import type { WslEnvironmentManager, WslServerConnection } from './wsl-environment-manager'

// This desktop's side of what a WSL distribution's Studio does on its machine
// for it (`distribution-machine.ts`), over the owner connection: git in a
// folder there, the home, and a watch on a git directory, which Windows cannot
// place itself (a watch on a `\\wsl.localhost` path is accepted and then hears
// nothing). The watch is the Studio's own `files.watchPath`, which an owner's
// connection may point at any folder, with nothing left out.
//
// Each starts the distribution's server if it is not running, as the WSL
// helper these replace was started for them. A watch outlives the connection
// it was placed on: when that connection goes (the server stopped for being
// idle, restarted, or its owner connection was made again), the watch is
// placed again on the next one, without starting a server for it, and says
// something changed, since what changed meanwhile went unheard.

type Manager = Pick<WslEnvironmentManager, 'connect' | 'current'>
type Owner = WslServerConnection['owner']

// How often a watch whose connection went looks for the server's next one.
const REARM_POLL_MS = 5_000

// Git ends at its own deadline in the distribution; this is how much longer
// the answer is waited for, from when the server was reached.
const ANSWER_SLACK_MS = 10_000

function within<T>(work: Promise<T>, ms: number | null, what: string): Promise<T> {
  if (ms === null) return work
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} gave no answer in time.`)), ms)
    timer.unref?.()
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

export function createWslMachineAccess(
  manager: () => Manager | null,
  unavailable: (distro: string) => Error,
): WslMachineAccess {
  const connect = (distro: string) => {
    const servers = manager()
    return servers ? servers.connect(distro) : Promise.reject(unavailable(distro))
  }
  return {
    git: async (distro, ask) =>
      within(
        (await connect(distro)).owner.request('environment.git', ask),
        ask.timeoutMs === null ? null : ask.timeoutMs + ANSWER_SLACK_MS,
        `The Studio server in ${distro}`,
      ),
    home: async (distro) => (await connect(distro)).owner.request('environment.home', {}),
    watchPath(distro, path, recursive, listener, onError) {
      let closed = false
      let unsubscribe: (() => void) | null = null
      let rearm: ReturnType<typeof setInterval> | null = null
      const stop = () => {
        closed = true
        unsubscribe?.()
        unsubscribe = null
        if (rearm) clearInterval(rearm)
        rearm = null
      }
      const fail = () => {
        if (closed) return
        stop()
        onError()
      }
      const place = (owner: Owner, again: boolean) => {
        if (closed) return
        unsubscribe = owner.subscribe(
          'files.watchPath',
          { path, includeIgnored: true },
          {
            onPayload(event) {
              if (closed) return
              const paths = event.paths ?? []
              // No names: something changed, which is all the watcher can say.
              if (event.overflow || paths.length === 0) {
                listener(null)
                return
              }
              // Studio watches the whole tree; a watch of the folder alone
              // hears only its own entries, as `fs.watch` without `recursive`.
              for (const name of paths) if (recursive || !name.includes('/')) listener(name)
            },
            onEnd() {
              unsubscribe = null
              if (closed) return
              // Refused while its connection stays open: this folder cannot be watched.
              if (owner.state === 'open') fail()
              else awaitNextConnection(owner)
            },
          },
        )
        if (again) listener(null)
      }
      // Never starts the server: a watch alone does not keep the VM awake.
      const awaitNextConnection = (gone: Owner) => {
        rearm = setInterval(() => {
          const next = manager()?.current(distro)
          if (closed || !next || next.owner === gone || next.owner.state !== 'open') return
          if (rearm) clearInterval(rearm)
          rearm = null
          place(next.owner, true)
        }, REARM_POLL_MS)
        rearm.unref?.()
      }
      void connect(distro).then((connection) => place(connection.owner, false), fail)
      return { close: stop }
    },
  }
}
