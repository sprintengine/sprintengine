// An extension's model provider and the key the person enters for it: kept
// under the provider's namespaced id, never read from the environment, and
// sent to the base URL's origin and nowhere else, not even by a redirect.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import type { ConversationEvent } from '../../shared/conversation-runtime'
import type { LoadedConversationProvider } from '../../shared/plugin-manifest'
import { extensionProviderOf } from '../plugin-registry-instance'
import { ProviderSecretStore } from '../secret-store'
import type { SecretCipher } from '../../server/platform/secret-cipher'
import { createOpenAiCompatibleProvider, listOpenAiCompatibleModels } from './openai-compatible-provider'

const ID = 'acme.models/acme'

function provider(
  overrides: { baseUrl?: string; chatCompletionsPath?: string; modelsPath?: string; apiKey?: boolean } = {},
) {
  return extensionProviderOf({
    id: ID,
    localId: 'acme',
    name: 'Acme',
    baseUrl: overrides.baseUrl ?? 'https://api.example.com/base',
    ...(overrides.chatCompletionsPath !== undefined ? { chatCompletionsPath: overrides.chatCompletionsPath } : {}),
    modelsPath: overrides.modelsPath ?? '/v1/models',
    models: [{ id: 'acme-large' }],
    ...(overrides.apiKey === false ? {} : { apiKey: { label: 'Acme API key' } }),
    extension: 'Acme models',
  })
}

/** A cipher that seals nothing, so a key lives in memory only. */
const NO_CIPHER: SecretCipher = {
  available: () => false,
  seal: () => {
    throw new Error('unavailable')
  },
  open: () => {
    throw new Error('unavailable')
  },
}

function storeFor(loaded: LoadedConversationProvider, env: NodeJS.ProcessEnv = {}) {
  return new ProviderSecretStore({
    resolveAuthOwner: (id) => (id === loaded.manifest.id ? loaded : undefined),
    resolveUserDataDir: () => mkdtempSync(join(tmpdir(), 'extension-provider-key-')),
    cipher: NO_CIPHER,
    env,
  })
}

type Sent = { url: string; headers: Record<string, string>; redirect: RequestRedirect | undefined }

function recordingFetch(sent: Sent[], body: () => Response): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      redirect: init?.redirect,
    })
    return body()
  }) as typeof fetch
}

const sse = () =>
  new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })

async function turn(adapter: ReturnType<typeof createOpenAiCompatibleProvider>): Promise<ConversationEvent[]> {
  const events = await adapter.sendTurn({
    sessionId: 'conv_1',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: ID,
    modelId: 'acme-large',
    turnId: 'turn_1',
    requestId: 'request_1',
    message: 'Hello',
  })
  if (Array.isArray(events)) return events
  const collected: ConversationEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

test('the key is kept under the namespaced id, and no environment variable stands in for it', async () => {
  const loaded = provider()
  // Even a variable named as a built-in provider's would be is never read.
  const store = storeFor(loaded, { ACME_API_KEY: 'from-env', OPENAI_API_KEY: 'from-env' })
  expect(await store.getStatus(ID)).toMatchObject({ ok: true, status: { configured: false, source: 'none' } })
  expect(await store.resolveSecret(ID)).toMatchObject({ ok: false })
  // A manifest that somehow carried a variable name still is not read: only a built-in's is.
  const smuggled = {
    ...loaded,
    manifest: { ...loaded.manifest, auth: { ...loaded.manifest.auth!, env: 'ACME_API_KEY' } },
  }
  expect(await storeFor(smuggled, { ACME_API_KEY: 'from-env' }).resolveSecret(ID)).toMatchObject({ ok: false })

  expect(await store.setSecret(ID, 'sk-entered')).toMatchObject({ ok: true, status: { configured: true } })
  expect(await store.resolveSecret(ID)).toMatchObject({ ok: true, value: 'sk-entered', source: 'session' })
  await store.forgetUnder('acme.models/')
  expect(await store.resolveSecret(ID)).toMatchObject({ ok: false })
})

test('a chat turn sends the key to the base URL’s origin only, and refuses to follow a redirect', async () => {
  const loaded = provider()
  const sent: Sent[] = []
  const adapter = createOpenAiCompatibleProvider({
    getProviderById: () => loaded,
    resolveSecret: async () => ({ ok: true, value: 'sk-entered' }),
    fetch: recordingFetch(sent, sse),
  })
  const events = await turn(adapter)
  expect(events.map((event) => event.type)).toContain('turn_completed')
  expect(sent).toHaveLength(1)
  expect(new URL(sent[0]!.url).origin).toBe('https://api.example.com')
  expect(sent[0]!.url).toBe('https://api.example.com/v1/chat/completions')
  expect(sent[0]!.headers.Authorization).toBe('Bearer sk-entered')
  expect(sent[0]!.redirect).toBe('error')
})

test('a path that would leave the origin is refused before anything is sent', async () => {
  for (const path of ['//elsewhere.example/v1/chat', '/\\elsewhere.example/v1/chat', 'https://elsewhere.example/x']) {
    const loaded = provider({ chatCompletionsPath: path })
    const sent: Sent[] = []
    const adapter = createOpenAiCompatibleProvider({
      getProviderById: () => loaded,
      resolveSecret: async () => ({ ok: true, value: 'sk-entered' }),
      fetch: recordingFetch(sent, sse),
    })
    const events = await turn(adapter)
    expect(events.at(-1)).toMatchObject({ type: 'turn_failed' })
    expect(sent, path).toEqual([])

    const models = await listOpenAiCompatibleModels({
      providerId: ID,
      getProviderById: () => provider({ modelsPath: path }),
      resolveSecret: async () => ({ ok: true, value: 'sk-entered' }),
      fetch: recordingFetch(sent, () => Response.json({ data: [] })),
    })
    expect(models.ok).toBe(false)
    expect(sent, path).toEqual([])
  }
})

test('the model list is asked of the same origin, without following a redirect', async () => {
  const sent: Sent[] = []
  const models = await listOpenAiCompatibleModels({
    providerId: ID,
    getProviderById: () => provider(),
    resolveSecret: async () => ({ ok: true, value: 'sk-entered' }),
    fetch: recordingFetch(sent, () => Response.json({ data: [{ id: 'acme-small' }] })),
  })
  expect(models).toEqual({ ok: true, models: [{ id: 'acme-small' }] })
  expect(sent).toEqual([
    {
      url: 'https://api.example.com/v1/models',
      headers: expect.objectContaining({ Authorization: 'Bearer sk-entered' }),
      redirect: 'error',
    },
  ])
})

test('a provider that takes no key is called without one, and never asks for it', async () => {
  const loaded = provider({ baseUrl: 'http://localhost:11434', apiKey: false })
  const sent: Sent[] = []
  let asked = 0
  const adapter = createOpenAiCompatibleProvider({
    getProviderById: () => loaded,
    resolveSecret: async () => {
      asked += 1
      return { ok: true, value: 'never' }
    },
    fetch: recordingFetch(sent, sse),
  })
  await turn(adapter)
  expect(asked).toBe(0)
  expect(sent[0]!.url).toBe('http://localhost:11434/v1/chat/completions')
  expect(sent[0]!.headers.Authorization).toBeUndefined()
})
