import { request as httpRequest } from 'http'

import {
  isTailnetScope,
  type TailnetPairRequestOutcome,
  type TailnetReverseGrant,
  type TailnetScope,
} from '../../../shared/tailnet'
import {
  checkTailnetTransportVersion,
  TAILNET_IDENTITY_PATH,
  TAILNET_PAIR_PATH,
  TAILNET_PAIR_COLLECT_PATH,
  TAILNET_PAIR_REQUEST_PATH,
} from './tailnet-routes'
import { asRecord } from '../../../shared/records'
import { isEnvironmentId } from '../../../../packages/studio-protocol/src/environment'

// The outbound client for tailnet remote control: the half that DIALS
// another machine's listener. Everything else under `tailnet/` answers calls;
// this places them.
//
// It lives in the main process, and not because that is convenient: the
// listener refuses any request carrying an `Origin` header, which a renderer's
// fetch and WebSocket both always send. The device token belongs here for the
// same kind of reason — a credential handed to a window is a credential one
// renderer bug away from the tailnet.
//
// Deliberately the same wire the stdio bridge speaks (`resources/automation/
// mcp-stdio-bridge.mjs`), because it IS the same protocol; the bridge cannot be
// imported (it is a dependency-free script for machines with no Studio at all)
// but the framing here is the app's own codec rather than a third copy.

/** A wrong port that accepts TCP and then says nothing must not hang the UI behind it. */
const REQUEST_TIMEOUT_MS = 10_000
/** Enough for any control response; a body larger than this is not our listener answering. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

export type TailnetEndpoint = { host: string; port: number }

export type RemoteCallOutcome<T> = { ok: true; value: T } | { ok: false; code: string; message: string }

/**
 * Split `host:port` — including the `[v6]:port` form the listener publishes.
 *
 * Returns null rather than guessing a port: an endpoint we cannot read is one we
 * must not dial, because the guess would be a request to somewhere nobody chose.
 */
export function parseTailnetEndpoint(value: string): TailnetEndpoint | null {
  const trimmed = value.trim()
  const bracketed = /^\[([^\]]+)\]:(\d+)$/u.exec(trimmed)
  if (bracketed) {
    const port = Number(bracketed[2])
    return isPort(port) ? { host: bracketed[1], port } : null
  }
  const separator = trimmed.lastIndexOf(':')
  if (separator <= 0) return null
  const host = trimmed.slice(0, separator)
  const port = Number(trimmed.slice(separator + 1))
  // An unbracketed colon in the host means a bare IPv6 literal, which is
  // ambiguous with the port separator; refuse it rather than truncate an address.
  if (!host || host.includes(':') || !isPort(port)) return null
  return { host, port }
}

export function formatTailnetEndpoint(endpoint: TailnetEndpoint): string {
  return endpoint.host.includes(':') ? `[${endpoint.host}]:${endpoint.port}` : `${endpoint.host}:${endpoint.port}`
}

/** A `sprintengine-tailnet://pair?…` link, as the other machine's Settings shows it. */
export function parsePairingUrl(value: string): { endpoint: TailnetEndpoint; pairingToken: string } | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'sprintengine-tailnet:') return null
  const endpointValue = url.searchParams.get('endpoint')
  const pairingToken = url.searchParams.get('token')
  if (!endpointValue || !pairingToken) return null
  const endpoint = parseTailnetEndpoint(endpointValue)
  return endpoint ? { endpoint, pairingToken } : null
}

type JsonAnswer = { status: number; body: unknown }

/** One HTTP round trip to a listener. Never throws for a status; a status is an answer. */
export function requestTailnetJson(input: {
  endpoint: TailnetEndpoint
  method: 'GET' | 'POST'
  path: string
  token?: string
  body?: unknown
  timeoutMs?: number
}): Promise<JsonAnswer> {
  const payload = input.body === undefined ? undefined : Buffer.from(JSON.stringify(input.body), 'utf8')
  const timeoutMs = input.timeoutMs ?? REQUEST_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const call = httpRequest(
      {
        host: input.endpoint.host,
        port: input.endpoint.port,
        method: input.method,
        path: input.path,
        headers: {
          Accept: 'application/json',
          Connection: 'close',
          // No Origin, ever: the listener refuses any request carrying one, and
          // rightly — see the transport notes in the knowledge graph.
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > MAX_RESPONSE_BYTES) {
            response.destroy()
            reject(new Error('the answer was larger than this transport carries'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let body: unknown = null
          try {
            body = text ? JSON.parse(text) : null
          } catch {
            body = null
          }
          resolve({ status: response.statusCode ?? 0, body })
        })
        response.on('error', reject)
      },
    )
    call.on('error', reject)
    call.setTimeout(timeoutMs, () => {
      call.destroy(new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`))
    })
    if (payload) call.write(payload)
    call.end()
  })
}

/** Redeem a one-time pairing code for a device token this machine can keep. */
export async function pairWithMachine(input: {
  endpoint: TailnetEndpoint
  pairingToken: string
  deviceName: string
}): Promise<RemoteCallOutcome<{ deviceId: string; deviceName: string; deviceToken: string; scopes: TailnetScope[] }>> {
  let answer: JsonAnswer
  try {
    answer = await requestTailnetJson({
      endpoint: input.endpoint,
      method: 'POST',
      path: TAILNET_PAIR_PATH,
      body: { pairingToken: input.pairingToken, deviceName: input.deviceName },
    })
  } catch (error) {
    return {
      ok: false,
      code: 'unreachable',
      message: `Could not reach ${formatTailnetEndpoint(input.endpoint)}: ${message(error)}.`,
    }
  }
  const record = asRecord(answer.body)
  if (answer.status !== 200 || typeof record?.deviceToken !== 'string') {
    const error = asRecord(record?.error)
    return {
      ok: false,
      code: typeof error?.code === 'string' ? error.code : `http_${answer.status}`,
      // The other machine's own words. A pairing refusal is the one moment a
      // person needs the exact reason — expired, already spent, wrong code.
      message: typeof error?.message === 'string' ? error.message : `Pairing was refused (HTTP ${answer.status}).`,
    }
  }
  return {
    ok: true,
    value: {
      deviceId: typeof record.deviceId === 'string' ? record.deviceId : '',
      deviceName: typeof record.deviceName === 'string' ? record.deviceName : input.deviceName,
      deviceToken: record.deviceToken,
      scopes: readScopes(record.scopes),
    },
  }
}

/**
 * Ask a machine to pair, for someone there to approve.
 *
 * Only the HASH of the collect secret goes over the wire; the secret itself
 * stays here and is presented to collect. The answer carries the comparison
 * code so this machine can show the same six digits the other one is showing.
 */
export async function requestPairingFromMachine(input: {
  endpoint: TailnetEndpoint
  deviceName: string
  collectHash: string
  /**
   * What this machine asks to be allowed to do there. Omitted rather than
   * defaulted when the caller names nothing: the far end owns that default, and
   * sending our idea of it would make an older listener and a newer one
   * disagree about a set neither of us chose.
   */
  scopes?: readonly TailnetScope[]
}): Promise<RemoteCallOutcome<{ requestId: string; comparisonCode: string; expiresAt: string }>> {
  let answer: JsonAnswer
  try {
    answer = await requestTailnetJson({
      endpoint: input.endpoint,
      method: 'POST',
      path: TAILNET_PAIR_REQUEST_PATH,
      body: {
        deviceName: input.deviceName,
        collectHash: input.collectHash,
        ...(input.scopes ? { scopes: [...input.scopes] } : {}),
      },
    })
  } catch (error) {
    return {
      ok: false,
      code: 'unreachable',
      message: `Could not reach ${formatTailnetEndpoint(input.endpoint)}: ${message(error)}.`,
    }
  }
  const record = asRecord(answer.body)
  if (answer.status !== 200 || typeof record?.requestId !== 'string') {
    const error = asRecord(record?.error)
    return {
      ok: false,
      code: typeof error?.code === 'string' ? error.code : `http_${answer.status}`,
      // The other machine's own words again — "there is already a request
      // waiting there" is the one thing a person needs to hear verbatim.
      message: typeof error?.message === 'string' ? error.message : `The request was refused (HTTP ${answer.status}).`,
    }
  }
  return {
    ok: true,
    value: {
      requestId: record.requestId,
      comparisonCode: typeof record.comparisonCode === 'string' ? record.comparisonCode : '',
      expiresAt: typeof record.expiresAt === 'string' ? record.expiresAt : '',
    },
  }
}

/**
 * Poll a request we made. The device token comes back to exactly one call.
 *
 * A POST with a body rather than the original GET (phase 6): when this
 * machine offered the other one a device here, `reverse` rides on the poll,
 * and the approver's listener stores it in the same exchange that hands our
 * token over. Sent on every poll rather than only the last, because there is
 * no way to know which poll will be the one that finds the approval.
 */
export async function collectPairingFromMachine(input: {
  endpoint: TailnetEndpoint
  requestId: string
  collectSecret: string
  reverse?: TailnetReverseGrant | null
}): Promise<RemoteCallOutcome<TailnetPairRequestOutcome>> {
  let answer: JsonAnswer
  try {
    answer = await requestTailnetJson({
      endpoint: input.endpoint,
      method: 'POST',
      path: TAILNET_PAIR_COLLECT_PATH,
      body: {
        id: input.requestId,
        secret: input.collectSecret,
        ...(input.reverse ? { reverse: input.reverse } : {}),
      },
    })
  } catch (error) {
    // A machine that has gone to sleep mid-wait is not a refusal: the caller
    // keeps polling rather than tearing the request down.
    return {
      ok: false,
      code: 'unreachable',
      message: `Could not reach ${formatTailnetEndpoint(input.endpoint)}: ${message(error)}.`,
    }
  }
  const record = asRecord(answer.body)
  const status = typeof record?.status === 'string' ? record.status : ''
  if (answer.status !== 200 || !status) {
    return { ok: false, code: `http_${answer.status}`, message: `The machine answered oddly (HTTP ${answer.status}).` }
  }
  if (status === 'approved') {
    return {
      ok: true,
      value: {
        status: 'approved',
        deviceId: typeof record?.deviceId === 'string' ? record.deviceId : '',
        deviceName: typeof record?.deviceName === 'string' ? record.deviceName : '',
        deviceToken: typeof record?.deviceToken === 'string' ? record.deviceToken : '',
        scopes: readScopes(record?.scopes),
      },
    }
  }
  if (status === 'pending') {
    return {
      ok: true,
      value: {
        status: 'pending',
        comparisonCode: typeof record?.comparisonCode === 'string' ? record.comparisonCode : '',
        expiresAt: typeof record?.expiresAt === 'string' ? record.expiresAt : '',
      },
    }
  }
  return { ok: true, value: { status: status === 'denied' ? 'denied' : 'expired' } }
}

/** What one authenticated handshake with a machine established. */
export type RemoteIdentity = {
  deviceId: string
  deviceName: string
  scopes: TailnetScope[]
  /**
   * That Studio's environment id, the same on every route to it and across a
   * rename. Null from a build before it said one, or one that said something
   * that cannot be an id.
   */
  environmentId: string | null
  /** The wire that machine speaks; always inside this build's window, or the call refused. */
  transportVersion: number
}

/**
 * What the remote says our device is and may do, right now.
 *
 * This is the handshake, and so it is where the transport version is enforced
 * (the first version shipped without that check, and a mismatched peer then failed later
 * on a payload shape instead). A machine outside the window is refused here
 * with a named code, so the Mesh records it as unreachable-with-a-reason
 * rather than as a machine that answered and then behaved oddly.
 *
 * `timeoutMs` is for the reachability check (phase 4), which asks this of
 * every paired machine on a timer: a sleeping laptop should cost a few
 * seconds per interval, not the ten a person-driven browse can afford.
 */
export async function readRemoteIdentity(input: {
  endpoint: TailnetEndpoint
  token: string
  timeoutMs?: number
}): Promise<RemoteCallOutcome<RemoteIdentity>> {
  let answer: JsonAnswer
  try {
    answer = await requestTailnetJson({
      endpoint: input.endpoint,
      method: 'GET',
      path: TAILNET_IDENTITY_PATH,
      token: input.token,
      timeoutMs: input.timeoutMs,
    })
  } catch (error) {
    return { ok: false, code: 'unreachable', message: describeUnreachable(input.endpoint, error) }
  }
  if (answer.status === 401) return { ok: false, code: 'unauthorized', message: UNAUTHORIZED_MESSAGE }
  const record = asRecord(answer.body)
  if (answer.status !== 200 || !record) {
    return { ok: false, code: `http_${answer.status}`, message: `That machine answered HTTP ${answer.status}.` }
  }
  const refusal = checkTailnetTransportVersion(record.transportVersion)
  if (refusal) return { ok: false, code: refusal.code, message: refusal.message }
  return {
    ok: true,
    value: {
      deviceId: typeof record.deviceId === 'string' ? record.deviceId : '',
      deviceName: typeof record.deviceName === 'string' ? record.deviceName : '',
      scopes: readScopes(record.scopes),
      environmentId: isEnvironmentId(record.environmentId) ? record.environmentId : null,
      transportVersion: record.transportVersion as number,
    },
  }
}

const UNAUTHORIZED_MESSAGE =
  'That machine no longer accepts this pairing. It was revoked there, or its app data was reset. Pair again to reconnect.'

function describeUnreachable(endpoint: TailnetEndpoint, error: unknown): string {
  return `${formatTailnetEndpoint(endpoint)} did not answer: ${message(error)}.`
}

function readScopes(value: unknown): TailnetScope[] {
  return Array.isArray(value) ? value.filter(isTailnetScope) : []
}

function isPort(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 65535
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
