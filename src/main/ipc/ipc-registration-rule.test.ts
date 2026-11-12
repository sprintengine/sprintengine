import assert from 'node:assert/strict'
import { test } from 'vitest'

import { mayRegisterInMain, noteModuleIpcChannel } from './ipc-registration-rule'

test('main may register a listed invoke or send channel, or a module channel the kernel noted, and nothing else', () => {
  assert.equal(mayRegisterInMain('window:close'), true)
  assert.equal(mayRegisterInMain('chat-link:ready'), true)
  // A push is main's to send, never a renderer's to reach.
  assert.equal(mayRegisterInMain('window:state-changed'), false)
  assert.equal(mayRegisterInMain('cli-runtime:install-output:codex'), false)
  assert.equal(mayRegisterInMain('weather-deck:forecast'), false)
  noteModuleIpcChannel('weather-deck:forecast')
  assert.equal(mayRegisterInMain('weather-deck:forecast'), true)
})
