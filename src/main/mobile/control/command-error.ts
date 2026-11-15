// Why a read or a change a client asked for was refused: the client named
// something it may not (a folder outside the projects held), something that
// is not there or not what it should be, or the work failed.

export type MobileControlRefusalCode = 'invalid_payload' | 'path_not_allowed' | 'internal_error'

export class MobileControlCommandError extends Error {
  constructor(
    readonly code: MobileControlRefusalCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
  }
}
