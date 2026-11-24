// How the authoring commands answer: words for a person, or with `--json`
// one JSON object an agent branches on, `{ ok: true, result }` or
// `{ ok: false, error: { code, message, data?, nextSteps? } }`. Branch on
// `error.code`, never on the words; the codes and exit codes below are kept.

/** Every code an authoring command fails with. */
export const CLI_ERROR_CODES = [
  /** A flag or argument is missing or wrong. */
  'invalid_argument',
  /** The extension is not one Studio can load: `data.issues` says where. */
  'extension_invalid',
  /** It is waiting for approval in Studio, which only the person gives there: `data.growth` when it asks for more. */
  'approval_required',
  /** No running Studio could be reached on this machine. */
  'studio_unavailable',
  /** That folder or extension is not loaded here. */
  'not_found',
  /** Its tests failed: the exit code is the runner's. */
  'extension_tests_failed',
  /** A worker failed to activate, or a surface would not load. */
  'extension_check_failed',
  /** A worker method answered with a failure (`data.requestCode`). */
  'extension_request_failed',
  /** A hook threw, timed out or answered nonsense. */
  'extension_hook_failed',
  /** The picture could not be taken. */
  'shot_failed',
  /** Studio could not do it now (it is starting, or something broke): try again. */
  'unavailable',
  // install, update and open:
  /** Studio's kill list removed that version: it never installs. */
  'killed',
  /** The version's bytes are not the ones Studio's release lock holds for it. */
  'release_lock_mismatch',
  /** What was fetched is not the release the catalogue lists (its hash, commit or manifest). */
  'release_mismatch',
  /** The repository's owner is not the one the key or the install names, or changed since. */
  'owner_mismatch',
  /** Studio cannot tell who owns the repository. */
  'owner_unknown',
  /** Studio could not read its kill list, so nothing installs until it can. */
  'kill_list_unavailable',
  /** It is installed from another source: remove it first. */
  'origin_conflict',
  /** It is installed already: `update` it, or the person removes it in Studio first. */
  'already_installed',
  /** A name only Studio's official catalogue installs. */
  'reserved_name',
  /** The catalogue changed what it lists since it was read: look again. */
  'changed',
  /** A community or added catalogue listed that release less than 12 hours ago: `data` says how long it still waits. */
  'held_back',
  /** The install failed for another reason: the message says why. */
  'install_failed',
  /** `update --all`: some were held or refused (none held for approval): `data.updates` has every row. */
  'update_failed',
  /** No Studio window is open on this machine to show it in. */
  'no_window',
  /** No Studio window here shows a workspace to show it in. */
  'no_workspace',
  /** It is switched off, or killed. */
  'extension_unavailable',
  /**
   * Not for this caller: a paired device's, or an agent on a capped preset
   * asking for what answers as the person (`open`, `shot`).
   */
  'not_permitted',
] as const

export type CliErrorCode = (typeof CLI_ERROR_CODES)[number]

/** Exit codes: 0 ok, 1 an error, 2 the extension is invalid, 3 it needs approval. */
export function exitCodeOf(code: string): number {
  if (code === 'extension_invalid') return 2
  if (code === 'approval_required') return 3
  return 1
}

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: Record<string, unknown>,
    readonly nextSteps?: string[],
    /** The exit code, when it is not the code's own (a test runner's). */
    readonly exitCode?: number,
  ) {
    super(message)
  }
}

export type Output = {
  json: boolean
  /** The command's answer: printed and exit 0. */
  done(result: Record<string, unknown>, words: string | string[]): never
  /** One line of a stream (`dev watch`): a JSON object per line, or words. */
  line(event: Record<string, unknown>, words: string): void
  fail(error: unknown): never
}

export function createOutput(json: boolean): Output {
  const fail = (error: unknown): never => {
    const failure =
      error instanceof CliError
        ? error
        : new CliError('unavailable', error instanceof Error ? error.message : String(error))
    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: false,
          error: {
            code: failure.code,
            message: failure.message,
            ...(failure.data ? { data: failure.data } : {}),
            ...(failure.nextSteps ? { nextSteps: failure.nextSteps } : {}),
          },
        })}\n`,
      )
    } else {
      console.error(`${failure.message}`)
      const issues = failure.data?.issues
      if (Array.isArray(issues))
        for (const issue of issues as Array<{ path?: string; message?: string }>)
          console.error(`  - ${issue.path ? `${issue.path}: ` : ''}${issue.message ?? ''}`)
      for (const step of failure.nextSteps ?? []) console.error(`Next: ${step}`)
    }
    process.exit(failure.exitCode ?? exitCodeOf(failure.code))
  }
  return {
    json,
    done(result, words) {
      if (json) process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`)
      else for (const line of Array.isArray(words) ? words : [words]) console.log(line)
      process.exit(0)
    },
    line(event, words) {
      if (json) process.stdout.write(`${JSON.stringify(event)}\n`)
      else console.log(words)
    },
    fail,
  }
}
