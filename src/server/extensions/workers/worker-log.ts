import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

// One extension's worker log: its own output and what Studio did with its
// process, one line each, under the logs folder. Kept to about a megabyte; the
// one before it is kept beside it as `.old.log`.

const MAX_BYTES = 1024 * 1024

export type WorkerLog = (line: string) => void

export function createWorkerLog(logDir: string, extensionId: string): WorkerLog {
  const safe = extensionId.replace(/[^A-Za-z0-9._-]/gu, '_')
  const path = join(logDir, `${safe}.log`)
  let ready = false
  let bytes = 0
  return (line) => {
    try {
      if (!ready) {
        mkdirSync(logDir, { recursive: true })
        try {
          bytes = statSync(path).size
        } catch {
          bytes = 0
        }
        ready = true
      }
      const text = `${new Date().toISOString()} ${line}\n`
      if (bytes + text.length > MAX_BYTES) {
        try {
          renameSync(path, join(logDir, `${safe}.old.log`))
        } catch {
          // Nothing to keep yet.
        }
        bytes = 0
      }
      appendFileSync(path, text)
      bytes += Buffer.byteLength(text)
    } catch {
      // A log that cannot be written must not stop the worker.
    }
  }
}
