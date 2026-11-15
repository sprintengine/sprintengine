import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { Readable } from 'node:stream'

import { stageId } from './wsl-process'
import { wslExeRunner, type WslRunner } from './wsl-runner'
import {
  buildCommitScript,
  buildStageScript,
  COMMITTED_MARKER,
  commitFailure,
  STAGED_MARKER,
  tarArgs,
  WSL_DATA_REL,
  type NeedReport,
} from './wsl-install'
import { ensureWslNodeArchive, wslNodeArch, wslNodePackage, WSL_NODE_VERSION } from './wsl-node-runtime'
import { WslSetupError } from './wsl-setup-error'

// Putting a tree into a WSL distribution: the pinned Node, and the Studio
// server a distribution runs (`desktop-wsl-servers.ts`). Each is staged,
// unpacked by `tar` from what `wsl.exe` streams in, then checked, marked and
// moved into place under the install lock (`wsl-install.ts` has the scripts).

/** A profile's id for its directories inside a machine: a hash of its userData directory. */
export function wslProfileId(userDataDir: string): string {
  return createHash('sha256').update(userDataDir).digest('hex').slice(0, 12)
}

/** The pinned Node archives' digests, any of which a Node ready marker may hold. */
export function wslNodeDigests(): string[] {
  return (['x64', 'arm64'] as const).flatMap((arch) =>
    (['xz', 'gz'] as const).map((compression) => wslNodePackage(arch, compression).sha256),
  )
}

const INSTALL_SCRIPT_TIMEOUT_MS = 3 * 60_000
const TAR_TIMEOUT_MS = 10 * 60_000

/**
 * Installs one tree into a distribution: staged, unpacked from `body` by
 * `tar`, then checked, marked and moved into place under the install lock.
 * Throws a `WslSetupError` naming what failed.
 */
export async function installTree(
  distro: string,
  input: {
    kind: 'node' | 'server'
    digest: string
    argv: (id: string) => string[]
    body: () => Buffer | Readable
  },
  appVersion: string,
  runner: WslRunner = wslExeRunner,
): Promise<void> {
  const id = stageId()
  const what = input.kind === 'node' ? 'Node.js' : 'the Studio server'
  const staged = await runner.runScript(distro, buildStageScript(id), { timeoutMs: INSTALL_SCRIPT_TIMEOUT_MS })
  if (!staged.stdout.includes(STAGED_MARKER)) {
    throw new WslSetupError(
      `Couldn't set up WSL: could not prepare ~/${WSL_DATA_REL} in ${distro} (${(staged.stderr || staged.stdout).trim()}).`,
      { fatal: !staged.timedOut, code: 'install' },
    )
  }
  const unpacked = await runner.runExec(distro, input.argv(id), input.body(), TAR_TIMEOUT_MS)
  if (unpacked.code !== 0 || unpacked.timedOut) {
    throw new WslSetupError(
      `Couldn't set up WSL: unpacking ${what} in ${distro} failed (${unpacked.stderr.trim() || `exit ${unpacked.code}`}).`,
      { fatal: !unpacked.timedOut, code: 'install' },
    )
  }
  const committed = await runner.runScript(
    distro,
    buildCommitScript(
      input.kind === 'node'
        ? { kind: 'node', stageId: id, digest: input.digest }
        : { kind: 'server', stageId: id, digest: input.digest, appVersion },
    ),
    { timeoutMs: INSTALL_SCRIPT_TIMEOUT_MS },
  )
  if (!committed.stdout.includes(COMMITTED_MARKER)) {
    const reason = commitFailure(committed.stdout, committed.stderr)
    const nodeRun = /^node-(run|version)/u.test(reason)
    const serverRun = /^server-(run|version)/u.test(reason)
    throw new WslSetupError(
      nodeRun
        ? `Couldn't set up WSL: Node.js ${WSL_NODE_VERSION} does not run in ${distro} (${reason}). It needs glibc 2.28 or later.`
        : serverRun
          ? `Couldn't set up WSL: the Studio server does not load in ${distro} (${reason}).`
          : `Couldn't set up WSL: installing into ${distro} failed (${reason || `exit ${committed.code}`}).`,
      { fatal: !committed.timedOut, code: nodeRun || serverRun ? 'node-run' : 'install' },
    )
  }
}

/**
 * The pinned Node, into a distribution that has none (or a broken one): the
 * archive for its architecture, downloaded once into `cacheDir` and checked.
 */
export async function installNodeInto(
  distro: string,
  report: Pick<NeedReport, 'arch' | 'xz'>,
  options: {
    cacheDir: string
    appVersion: string
    fetch?: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>
    log?: (message: string) => void
  },
  runner: WslRunner = wslExeRunner,
): Promise<void> {
  const arch = wslNodeArch(report.arch)
  if (!arch) {
    throw new WslSetupError(
      `Couldn't set up WSL: ${distro} runs on ${report.arch || 'an unknown processor'}, and Studio ships Node.js for x86_64 and arm64 only.`,
      { fatal: true, code: 'unsupported-arch' },
    )
  }
  const pkg = wslNodePackage(arch, report.xz ? 'xz' : 'gz')
  options.log?.(`Installing Node.js ${WSL_NODE_VERSION} (${pkg.fileName}) into ${distro}.`)
  const archive = await ensureWslNodeArchive(pkg, {
    cacheDir: options.cacheDir,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  await installTree(
    distro,
    { kind: 'node', digest: pkg.sha256, argv: (id) => tarArgs('node', id, pkg), body: () => createReadStream(archive) },
    options.appVersion,
    runner,
  )
}
