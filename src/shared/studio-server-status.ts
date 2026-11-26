// What a window is told about the Studio server, for the words it shows (a
// banner while the server starts, reconnects or has stopped; the Settings
// section with its process and its actions). Never a status dot: a state is
// said in a sentence.

export const STUDIO_SERVER_CHANNELS = {
  status: 'studio-server:status',
  changed: 'studio-server:status-changed',
  retry: 'studio-server:retry',
  restart: 'studio-server:restart',
  openLog: 'studio-server:open-log',
  info: 'studio-server:info',
} as const

/** Where the server is in its life, in the words the window uses. */
export type StudioServerPhase =
  | 'starting'
  | 'running'
  /** It stopped and is being started again. */
  | 'reconnecting'
  /** It kept failing, or refused to start: a person has to act. */
  | 'stopped'
  | 'stopping'

export type StudioServerStatus = {
  phase: StudioServerPhase
  /** Why it stopped, in the server's own words where it gave some. */
  reason: string | null
  pid: number | null
  restarts: number
  startedAt: number | null
}

export type StudioServerInfo = {
  pid: number
  uptimeMs: number
  version: string
  gatewaySocket: string | null
  cipher: string
  rssMb: number
  loopLagMs: number | null
}
