import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ArtifactsSetupQuestionView } from '../../shared/artifacts'
import { createArtifactsSetupConsentBroker } from './artifacts-setup-consent-broker'
import { artifactsSetupQuestion } from './artifacts-setup-consent'

const QUESTION = artifactsSetupQuestion({ provider: 'github-pages', repositoryUrl: 'acme/artifacts' }, 'Claude Code')

function broker(options: { hasWindow?: boolean; timeoutMs?: number; fallback?: boolean } = {}) {
  const heard: ArtifactsSetupQuestionView[][] = []
  let fallbackAsked = 0
  const made = createArtifactsSetupConsentBroker({
    hasWindow: () => options.hasWindow ?? true,
    fallback: async () => {
      fallbackAsked += 1
      return options.fallback ?? false
    },
    timeoutMs: options.timeoutMs ?? 60_000,
  })
  made.onQuestions((questions) => heard.push(questions))
  const asked = () => made.questions()[0] as ArtifactsSetupQuestionView
  return { made, heard, asked, fallbackAsked: () => fallbackAsked }
}

test('the question is open for the windows to follow, and the first answer settles it', async () => {
  const { made, heard, asked } = broker()
  assert.deepEqual(heard, [[]], 'a follower hears what is open when it starts')
  const answer = made.ask(QUESTION, new AbortController().signal)
  const view = asked()
  assert.equal(view.message, 'Publish artifacts with GitHub Pages?')
  assert.match(view.detail, /^Claude Code asks to set this up\./)
  assert.equal(view.confirmLabel, 'Set up GitHub Pages')
  assert.deepEqual(heard.at(-1), [view])
  assert.equal(made.answer('another-id', true), false, 'an answer to no open question does nothing')
  assert.equal(made.answer(view.id, true), true)
  assert.equal(await answer, true)
  assert.deepEqual(heard.at(-1), [], 'every follower hears it is gone')
  assert.equal(made.answer(view.id, false), false, 'a second answer does nothing')
  assert.equal(heard.length, 3)
})

test('two questions are open together, each answered on its own', async () => {
  const { made } = broker()
  const first = made.ask(QUESTION, new AbortController().signal)
  const second = made.ask(QUESTION, new AbortController().signal)
  const [a, b] = made.questions()
  assert.ok(a && b && a.id !== b.id)
  made.answer(b.id, false)
  assert.deepEqual(
    made.questions().map((question) => question.id),
    [a.id],
  )
  made.answer(a.id, true)
  assert.deepEqual([await first, await second], [true, false])
})

test('a follower that stops hears nothing more', () => {
  const made = createArtifactsSetupConsentBroker({
    hasWindow: () => true,
    fallback: async () => false,
    timeoutMs: 60_000,
  })
  const heard: number[] = []
  const stop = made.onQuestions((questions) => heard.push(questions.length))
  stop()
  void made.ask(QUESTION, new AbortController().signal)
  assert.deepEqual(heard, [0])
  made.answer(made.questions()[0]!.id, false)
})

test('no, no answer in time, and a cancelled call are all no', async () => {
  const refused = broker()
  const no = refused.made.ask(QUESTION, new AbortController().signal)
  refused.made.answer(refused.asked().id, false)
  assert.equal(await no, false)

  const notAnswered = broker({ timeoutMs: 20 })
  assert.equal(await notAnswered.made.ask(QUESTION, new AbortController().signal), false)
  assert.deepEqual(notAnswered.made.questions(), [])

  const cancelled = broker()
  const controller = new AbortController()
  const pending = cancelled.made.ask(QUESTION, controller.signal)
  controller.abort()
  assert.equal(await pending, false)
  assert.deepEqual(cancelled.heard.at(-1), [])
})

test('with no window showing, the native question asks instead', async () => {
  const { made, heard, fallbackAsked } = broker({ hasWindow: false, fallback: true })
  assert.equal(await made.ask(QUESTION, new AbortController().signal), true)
  assert.equal(fallbackAsked(), 1)
  assert.deepEqual(heard, [[]], 'nothing was opened for a window')
})

test('the question names the repository it parsed, and never carries a token', () => {
  const cloudflare = artifactsSetupQuestion(
    { provider: 'cloudflare-pages', accountName: 'Acme', projectName: '', sourceRepositoryUrl: null },
    null,
  )
  assert.equal(cloudflare.message, 'Publish artifacts with Cloudflare Pages?')
  assert.match(cloudflare.detail, /^An agent asks to set this up\./)
  assert.match(cloudflare.detail, /Account: Acme\nProject: studio-artifacts \(made if there is none\)/)
  const github = artifactsSetupQuestion(
    { provider: 'github-pages', repositoryUrl: 'git@git.acme.example:design/site.git' },
    null,
  )
  assert.match(github.detail, /Repository: design\/site on git\.acme\.example/)
})
