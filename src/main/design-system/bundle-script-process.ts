import { spawn, type ChildProcess } from 'node:child_process'

import { bundleScriptEnv } from './bundle-script-env'
import type { BundleScriptExit, BundleScriptFork } from './bundle-lint-run'

// Bundle scripts run in a process of their own, never in the Studio's: the
// same trust boundary as the designer session that authored them. The Studio
// server runs them wherever it runs (in the desktop, in a process of its own,
// on a WSL or SSH machine), with the Node it runs on: plain Node for a
// standalone server, the app's binary as Node inside the desktop. No IPC
// channel is opened, so a script's event loop ends when its work does; the
// timeout below is the backstop for one that never ends.
const SCRIPT_TIMEOUT_MS = 30_000

// 'exit' can fire before the final stdio chunks are delivered; wait briefly
// for the pipes to close so failure stderr is never truncated.
const STREAM_DRAIN_GRACE_MS = 500

function streamClosed(stream: NodeJS.ReadableStream | null): Promise<void> {
  if (!stream) return Promise.resolve()
  return new Promise((resolve) => {
    stream.once('close', resolve)
    stream.once('end', resolve)
  })
}

export const runBundleScriptInChildProcess: BundleScriptFork = (scriptPath, args, options) =>
  new Promise<BundleScriptExit>((resolve) => {
    let child: ChildProcess
    try {
      // Bundle scripts never see the Studio's full env, only the minimal
      // allowlist (bundle-script-env.ts): its secrets must not reach every
      // generator script the runner executes.
      child = spawn(process.execPath, [scriptPath, ...args], {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...bundleScriptEnv(process.env), ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
        windowsHide: true,
      })
    } catch (error) {
      resolve({
        exitCode: null,
        stdout: '',
        stderr: `failed to start ${scriptPath}: ${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    const drained = Promise.all([streamClosed(child.stdout), streamClosed(child.stderr)])

    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve({
        exitCode: null,
        stdout,
        stderr: `${stderr}\n[design-system] ${scriptPath} timed out after ${SCRIPT_TIMEOUT_MS}ms and was killed`,
      })
    }, SCRIPT_TIMEOUT_MS)

    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({ exitCode: null, stdout, stderr: `failed to start ${scriptPath}: ${error.message}` })
    })
    child.once('exit', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      void Promise.race([drained, new Promise((graceOver) => setTimeout(graceOver, STREAM_DRAIN_GRACE_MS))]).then(() =>
        resolve({ exitCode, stdout, stderr }),
      )
    })
  })
