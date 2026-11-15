import assert from 'node:assert/strict'

import { afterEach, test } from 'vitest'

import { EMPTY_ARTIFACTS_SETTINGS, type ArtifactsSettingsView, type ArtifactsSetupInput } from '../../shared/artifacts'
import { STUDIO_ARTIFACTS_METHODS, type StudioScope } from '../../../packages/studio-protocol/src/public'
import { createArtifactsSetupConsentBroker } from '../../main/artifacts/artifacts-setup-consent-broker'
import { artifactsSetupQuestion } from '../../main/artifacts/artifacts-setup-consent'
import type { StudioArtifacts } from '../artifacts/artifacts-domain'
import { connectLineClient, hello, OWNER_TOKEN, pairFakeClient, startTestServer } from './studio-rpc.test-helper'

// The artifacts family over the owner socket: every method and the set-up
// question stream are an owner's, so a pairing given every scope is refused
// each and hears no question. A set-up is carried out once per command id,
// and the set-up questions are followed whole: what is open when a window
// subscribes, then the list again on each change. The domain is a stub over
// the real consent broker; what a set-up does is artifacts-setup's tests'.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Method = keyof typeof STUDIO_ARTIFACTS_METHODS

const TOKEN = 'cf-secret-token'

/** Each method with params its validator takes. */
const CALLS: Record<Method, Record<string, unknown>> = {
  'artifacts.settings': {},
  'artifacts.setUp': {
    commandId: 'c-setup',
    save: true,
    input: { provider: 'cloudflare-pages', token: TOKEN, projectName: 'site' },
  },
  'artifacts.answerSetupQuestion': { commandId: 'c-answer', id: 'no-such-question', confirmed: true },
}

const VIEW: ArtifactsSettingsView = {
  ...EMPTY_ARTIFACTS_SETTINGS,
  cloudflareToken: { configured: true, encryptionAvailable: true },
  siteUrl: null,
}

function stub() {
  const setUps: Array<{ input: ArtifactsSetupInput; save: boolean }> = []
  const consent = createArtifactsSetupConsentBroker({
    hasWindow: () => true,
    fallback: async () => false,
    timeoutMs: 60_000,
  })
  const artifacts: StudioArtifacts = {
    settings: async () => VIEW,
    setUp: async (input, save) => {
      setUps.push({ input, save })
      return { ok: true, steps: [], siteUrl: null, saved: save, view: VIEW }
    },
    setupQuestions: consent.questions,
    onSetupQuestions: consent.onQuestions,
    answerSetupQuestion: consent.answer,
    tools: [],
  }
  return { artifacts, setUps, consent }
}

async function serve(withArtifacts = true) {
  const domain = stub()
  const started = await startTestServer(withArtifacts ? { artifacts: domain.artifacts } : {})
  cleanups.push(() => started.dispose())
  return { started, ...domain }
}

async function client(path: string, token: string) {
  const line = await connectLineClient(path)
  cleanups.push(() => line.close())
  line.send(hello({ token }))
  const welcome = await line.next((frame) => frame.t === 'welcome')
  let seq = 0
  return {
    line,
    welcome,
    async request(method: string, params: unknown) {
      const id = `r${++seq}`
      line.send({ t: 'req', id, method, params })
      return line.next((frame) => frame.t === 'res' && frame.id === id)
    },
    subscribe(topic: string, params: unknown = {}) {
      const id = `s${++seq}`
      line.send({ t: 'sub', id, topic, params })
      return id
    },
  }
}

const codeOf = (frame: { t: string; ok?: boolean; error?: { code: string } }) =>
  frame.t === 'res' && !frame.ok ? (frame.error?.code ?? null) : null

const QUESTION = artifactsSetupQuestion({ provider: 'github-pages', repositoryUrl: 'acme/artifacts' }, 'Claude Code')

test('every method of the family has a call here', () => {
  assert.deepEqual(Object.keys(CALLS).sort(), Object.keys(STUDIO_ARTIFACTS_METHODS).sort())
})

test('a Studio advertises artifacts only where it publishes them, and refuses them otherwise', async () => {
  const none = await serve(false)
  const owner = await client(none.started.path, OWNER_TOKEN)
  assert.equal(owner.welcome.t === 'welcome' && owner.welcome.capabilities.includes('artifacts'), false)
  assert.equal(codeOf(await owner.request('artifacts.settings', {})), 'unavailable')

  const held = await serve()
  const window = await client(held.started.path, OWNER_TOKEN)
  assert.ok(window.welcome.t === 'welcome' && window.welcome.capabilities.includes('artifacts'))
})

test('an owner reads and sets up; the token goes in and never comes back; a retry is the first answer', async () => {
  const { started, setUps } = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  for (const [method, params] of Object.entries(CALLS)) {
    const answer = await owner.request(method, params)
    assert.deepEqual([method, codeOf(answer)], [method, null])
    assert.equal(JSON.stringify(answer).includes(TOKEN), false, `${method} never answers the token`)
  }
  assert.deepEqual(setUps, [{ input: { provider: 'cloudflare-pages', token: TOKEN, projectName: 'site' }, save: true }])
  await owner.request('artifacts.setUp', CALLS['artifacts.setUp'])
  assert.equal(setUps.length, 1, 'a retry under the same command id is answered from the first')
  const odd = await owner.request('artifacts.setUp', {
    commandId: 'c-odd',
    save: true,
    input: { provider: 'netlify' },
  })
  assert.equal(codeOf(odd), 'invalid_params')
})

test('a pairing given every scope is refused each method and the question stream', async () => {
  const { started, setUps, consent } = await serve()
  const scopes: StudioScope[] = [
    'providers:read',
    'files:read',
    'files:write',
    'environment:maintain',
    'settings:write',
    'modules:read',
    'modules:operate',
    'workspaces:operate',
  ]
  const app = await client(started.path, pairFakeClient(started.auth, 'app', scopes))
  for (const [method, params] of Object.entries(CALLS))
    assert.deepEqual([method, codeOf(await app.request(method, params))], [method, 'owner_required'])
  assert.deepEqual(setUps, [])

  const asking = consent.ask(QUESTION, new AbortController().signal)
  const [open] = consent.questions()
  assert.ok(open)
  const sub = app.subscribe('artifacts.setupQuestions')
  const refused = await app.line.next((frame) => frame.t !== 'res' && 'sub' in frame && frame.sub === sub)
  assert.notEqual(refused.t, 'push', JSON.stringify(refused))
  assert.equal(
    codeOf(await app.request('artifacts.answerSetupQuestion', { commandId: 'c-yes', id: open.id, confirmed: true })),
    'owner_required',
  )
  consent.answer(open.id, false)
  assert.equal(await asking, false, 'only the owner’s answer counts')
})

test('a window following the questions sees what is open, each new one, and each one go', async () => {
  const { started, consent } = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  const first = consent.ask(QUESTION, new AbortController().signal)
  const sub = owner.subscribe('artifacts.setupQuestions')
  type Pushed = { questions: Array<{ id: string; message: string; detail: string }> }
  const next = async () => {
    const frame = await owner.line.next((pushed) => pushed.t === 'push' && pushed.sub === sub)
    return (frame.t === 'push' ? frame.payload : null) as Pushed
  }
  const opened = await next()
  assert.equal(opened.questions.length, 1, 'what was open before it subscribed')
  assert.equal(opened.questions[0]?.message, 'Publish artifacts with GitHub Pages?')

  const second = consent.ask(QUESTION, new AbortController().signal)
  assert.equal((await next()).questions.length, 2)

  const [a, b] = consent.questions()
  const answered = await owner.request('artifacts.answerSetupQuestion', {
    commandId: 'c-yes',
    id: a!.id,
    confirmed: true,
  })
  assert.deepEqual(answered.t === 'res' && answered.ok && answered.result, { answered: true })
  assert.deepEqual(
    (await next()).questions.map((question) => question.id),
    [b!.id],
  )
  assert.equal(await first, true)

  const late = await owner.request('artifacts.answerSetupQuestion', {
    commandId: 'c-late',
    id: a!.id,
    confirmed: false,
  })
  assert.deepEqual(late.t === 'res' && late.ok && late.result, { answered: false }, 'a second answer does nothing')

  consent.answer(b!.id, false)
  assert.deepEqual((await next()).questions, [])
  assert.equal(await second, false)
})
