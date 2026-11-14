import { randomBytes } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'

import { WslSetupError } from './wsl-setup-error'

// A process this desktop starts through `wsl.exe` and talks to over its stdio:
// a distribution's Studio server while it starts, the stdio bridge to its
// front door, and the install scripts. And what `wsl.exe` printed when one of
// them failed, sorted into what is worth trying again and what is not.

export type WslStdioProcess = {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  pid?: number
  kill(): void
  /** After the process exited and its pipes closed, so all of its output has been read. */
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
}

/** What `wsl.exe` printed when it failed, classified. */
export function classifyWslFailure(text: string, code: number | null): WslSetupError {
  const flat = text.replace(/\0/g, '').replace(/\s+/gu, ' ').trim()
  if (/WSL_E_DISTRO_NOT_FOUND|no distribution with the supplied name|has no installed distributions/iu.test(flat)) {
    return new WslSetupError(`Couldn't set up WSL: this distribution is not installed. ${flat}`.trim(), {
      fatal: true,
      code: 'distro-missing',
    })
  }
  if (
    /WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED|Subsystem for Linux (has not been|is not) (enabled|installed)/iu.test(flat)
  ) {
    return new WslSetupError(
      'Couldn\'t set up WSL: WSL is not installed on this PC. Install it with "wsl --install".',
      {
        fatal: true,
        code: 'wsl-missing',
      },
    )
  }
  // Exec failures from the launch script's final line: the pinned Node could
  // not run (a missing glibc, the wrong architecture).
  if (code === 126 || code === 127 || /GLIBC_|cannot execute|Exec format error/iu.test(flat)) {
    return new WslSetupError(
      `Couldn't set up WSL: Node.js does not run in this distribution (${flat || `exit ${code}`}). ` +
        'Studio needs glibc 2.28 or later there.',
      { fatal: true, code: 'node-run' },
    )
  }
  return new WslSetupError(`The Studio server in WSL did not start (${flat || `exit ${code ?? 'unknown'}`}).`, {
    fatal: false,
    code: 'start',
  })
}

/** A short random id for a staging directory. */
export function stageId(): string {
  return randomBytes(6).toString('hex')
}
