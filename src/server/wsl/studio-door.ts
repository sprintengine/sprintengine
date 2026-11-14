import type { Duplex } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

import type { StudioTransport } from '../../../packages/client-runtime/src/public'

// A Studio protocol connection over an admitted `studio` front-door stream
// (a WSL server's door, or an SSH machine's through its relay): the door says
// a one-use owner ticket first, then the protocol runs one frame per line.

/** A Studio protocol transport over an admitted stream: one frame per line, saying hello with `ticket`. */
export function lineTransport(stream: Duplex, ticket: string): StudioTransport {
  const decoder = new StringDecoder('utf8')
  const messageListeners: Array<(frame: string) => void> = []
  const closeListeners: Array<(error?: Error) => void> = []
  let buffer = ''
  let failure: Error | undefined
  stream.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim()) for (const listener of messageListeners) listener(line)
      newline = buffer.indexOf('\n')
    }
  })
  stream.on('error', (error: Error) => {
    failure = error
  })
  stream.once('close', () => {
    for (const listener of closeListeners) listener(failure)
  })
  return {
    credential: { token: ticket },
    send: (frame) => void stream.write(`${frame}\n`),
    close: () => {
      stream.end()
      stream.destroy()
    },
    onMessage: (listener) => void messageListeners.push(listener),
    onClose: (listener) => void closeListeners.push(listener),
    pause: () => void stream.pause(),
    resume: () => void stream.resume(),
  }
}

/** The ticket line a `studio` door says first, then the stream for the protocol. */
export function readTicket(stream: Duplex, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const done = (error: Error | null, ticket?: string) => {
      clearTimeout(timer)
      stream.off('readable', onReadable)
      stream.off('close', onClose)
      if (error) reject(error)
      else resolve(ticket!)
    }
    const onClose = () => done(new Error('The Studio server closed the connection before it gave a ticket.'))
    const onReadable = () => {
      let chunk: Buffer | null
      while ((chunk = stream.read() as Buffer | null) !== null) {
        buffer = Buffer.concat([buffer, chunk])
        const newline = buffer.indexOf(0x0a)
        if (newline === -1) continue
        const rest = buffer.subarray(newline + 1)
        if (rest.length > 0) stream.unshift(rest)
        try {
          const line = JSON.parse(buffer.subarray(0, newline).toString('utf8')) as { t?: unknown; ticket?: unknown }
          if (line.t !== 'ticket' || typeof line.ticket !== 'string') throw new Error('no ticket')
          done(null, line.ticket)
        } catch {
          done(new Error('The Studio server did not give a ticket.'))
        }
        return
      }
    }
    const timer = setTimeout(() => done(new Error('The Studio server gave no ticket in time.')), timeoutMs)
    timer.unref?.()
    stream.on('readable', onReadable)
    stream.once('close', onClose)
  })
}
