import { type spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'

import { cliHostSpawn, spawnCliHostChild } from './cli-host-child'
import { resolveGatewayLaunchToken } from '../../server/core/gateway-launch-tokens'

const TOKEN = 'tok_0123456789abcdefghijklmnopqrstuvwxyz'

describe('cliHostSpawn', () => {
  it('starts a CLI on this machine as it is, in the workspace folder', () => {
    const plan = cliHostSpawn(
      { command: '/usr/local/bin/codex', args: ['app-server'], cwd: '/Users/dev/repo', env: { PATH: '/usr/bin' } },
      { platform: 'darwin' },
    )
    expect(plan.file).toBe('/usr/local/bin/codex')
    expect(plan.args).toEqual(['app-server'])
    expect(plan.options).toMatchObject({ cwd: '/Users/dev/repo', env: { PATH: '/usr/bin' }, windowsHide: true })
    expect(plan.options.stdio).toEqual(['pipe', 'pipe', 'pipe'])
  })

  it("starts a Windows shim through the command processor, as this machine's CLIs always have", () => {
    const plan = cliHostSpawn(
      {
        command: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\opencode.cmd',
        args: ['acp'],
        cwd: 'C:\\Users\\dev\\repo',
        env: { ComSpec: 'cmd.exe' },
      },
      { platform: 'win32' },
    )
    expect(plan.file).toBe('cmd.exe')
    expect(plan.options).toMatchObject({ cwd: 'C:\\Users\\dev\\repo', windowsVerbatimArguments: true })
  })

  it("lists a distribution's folder as safe for the agent's git when the chat runs on This PC there", () => {
    const plan = cliHostSpawn(
      {
        command: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.exe',
        args: ['app-server'],
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\app',
        // The person's own entry keeps its place; the folder's follow it.
        env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' },
      },
      { platform: 'win32' },
    )
    const env = plan.options.env as NodeJS.ProcessEnv
    expect(env.GIT_CONFIG_COUNT).toBe('5')
    expect([env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0]).toEqual(['core.autocrlf', 'false'])
    expect([1, 2, 3, 4].map((n) => [env[`GIT_CONFIG_KEY_${n}`], env[`GIT_CONFIG_VALUE_${n}`]])).toEqual([
      ['safe.directory', '%(prefix)///wsl.localhost/Ubuntu/home/dev/app'],
      ['safe.directory', '%(prefix)///wsl.localhost/Ubuntu/home/dev'],
      ['safe.directory', '%(prefix)///wsl.localhost/Ubuntu/home'],
      ['safe.directory', '%(prefix)///wsl.localhost/Ubuntu'],
    ])
    // A folder on a drive, or a chat in the distribution itself, gets none.
    const onDrive = cliHostSpawn(
      { command: 'codex.exe', args: [], cwd: 'C:\\Users\\dev\\app', env: {} },
      { platform: 'win32' },
    )
    expect((onDrive.options.env as NodeJS.ProcessEnv).GIT_CONFIG_COUNT).toBeUndefined()
  })
})

describe('launch tokens for chat children', () => {
  function spawnRecorder() {
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = []
    const children: EventEmitter[] = []
    const stand = ((_file: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      calls.push(options)
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        pid: 9,
      })
      children.push(child)
      return child
    }) as unknown as typeof spawn
    return { spawn: stand, calls, children }
  }
  const identity = {
    SPRINTENGINE_WORKSPACE_ID: 'ws-1',
    SPRINTENGINE_AGENT_ID: 'chat-1',
    SPRINTENGINE_AGENT_CLI: 'codex',
  }

  it('gives a conversation’s child on this machine a token bound to that conversation, until it ends', () => {
    const recorder = spawnRecorder()
    spawnCliHostChild({ command: 'codex', args: [], cwd: '/Users/dev/app', env: identity }, { spawn: recorder.spawn })
    const token = recorder.calls[0].env?.SPRINTENGINE_MCP_CHANNEL_TOKEN ?? ''
    expect(token).toMatch(/^selaunch_/)
    expect(resolveGatewayLaunchToken(token)).toEqual({ workspaceId: 'ws-1', agentId: 'chat-1', cliId: 'codex' })
    recorder.children[0].emit('close', 0)
    expect(resolveGatewayLaunchToken(token)).toBeNull()
  })

  it('hands a child that is no conversation’s no token, not even one the app inherited', () => {
    const recorder = spawnRecorder()
    spawnCliHostChild(
      { command: 'codex', args: [], cwd: '/Users/dev/app', env: { SPRINTENGINE_MCP_CHANNEL_TOKEN: TOKEN } },
      { spawn: recorder.spawn },
    )
    expect(recorder.calls[0].env?.SPRINTENGINE_MCP_CHANNEL_TOKEN).toBeUndefined()
  })

  it('takes a conversation’s token back when its child never started', () => {
    const notStarted = spawnRecorder()
    const child = spawnCliHostChild(
      { command: 'codex', args: [], cwd: '/Users/dev/app', env: identity },
      { spawn: notStarted.spawn },
    )
    const token = notStarted.calls[0].env?.SPRINTENGINE_MCP_CHANNEL_TOKEN ?? ''
    Object.assign(child, { pid: undefined })
    child.emit('error', new Error('ENOENT'))
    expect(resolveGatewayLaunchToken(token)).toBeNull()
    let thrownWith = ''
    const throwing = ((_file: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      thrownWith = options.env?.SPRINTENGINE_MCP_CHANNEL_TOKEN ?? ''
      throw new Error('EACCES')
    }) as unknown as typeof spawn
    expect(() =>
      spawnCliHostChild({ command: 'codex', args: [], cwd: '/Users/dev/app', env: identity }, { spawn: throwing }),
    ).toThrow('EACCES')
    expect(thrownWith).toMatch(/^selaunch_/)
    expect(resolveGatewayLaunchToken(thrownWith)).toBeNull()
  })

  it('hands a child the token its runtime issued for it in place of one of its own, and takes it back', () => {
    const recorder = spawnRecorder()
    const revoked: string[] = []
    // The environment names no conversation (an ACP agent's): the runtime issued the token itself.
    spawnCliHostChild(
      {
        command: 'agent',
        args: ['acp'],
        cwd: '/Users/dev/app',
        env: {},
        launch: { token: TOKEN, revoke: () => revoked.push(TOKEN) },
      },
      { spawn: recorder.spawn },
    )
    expect(recorder.calls[0].env?.SPRINTENGINE_MCP_CHANNEL_TOKEN).toBe(TOKEN)
    recorder.children[0].emit('close', 0)
    expect(revoked).toEqual([TOKEN])

    // A child that cannot be started gives it back at once.
    const failed: string[] = []
    expect(() =>
      spawnCliHostChild(
        {
          command: 'agent',
          args: [],
          cwd: '/Users/dev/app',
          env: {},
          launch: { token: TOKEN, revoke: () => failed.push(TOKEN) },
        },
        {
          spawn: (() => {
            throw new Error('spawn agent ENOENT')
          }) as unknown as typeof spawn,
        },
      ),
    ).toThrow('ENOENT')
    expect(failed).toEqual([TOKEN])

    // Null from the runtime is no token, not one of the child's own.
    spawnCliHostChild(
      { command: 'codex', args: [], cwd: '/Users/dev/app', env: identity, launch: null },
      { spawn: recorder.spawn },
    )
    expect(recorder.calls[1].env?.SPRINTENGINE_MCP_CHANNEL_TOKEN).toBeUndefined()
  })
})
