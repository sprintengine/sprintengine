import assert from 'node:assert/strict'

import type {
  MarketplacePluginRegistryInstallResult,
  MarketplacePluginVerifyResult,
} from '../../../../shared/electron-api'
import {
  classifyVerification,
  deriveInstallView,
  installNeedsWorkspace,
  summarizeInstallResult,
  type InstallFlowState,
} from './installFlow'
import { test } from 'vitest'

test('installFlow', async () => {
  // The trust gate must disclose REAL verified permissions before trust and must
  // never fake an install: verified installs directly; community AND unsigned
  // earn the trust prompt populated from the verify IPC, carrying the token main
  // issued for it; invalid hard-blocks with no install affordance; and the seven
  // flow states each render an explicit view.

  function verify(overrides: Partial<MarketplacePluginVerifyResult> = {}): MarketplacePluginVerifyResult {
    return {
      classification: 'verified',
      permissions: [],
      sourceUrl: 'https://github.com/sprintengine/studio-releases/tree/main/plugins/x',
      trustToken: 'token-from-verify',
      ...overrides,
    }
  }

  // --- classifyVerification --------------------------------------------------

  {
    // Verified → install directly (no trust prompt), still passing the token so
    // main installs exactly what verify read.
    const outcome = classifyVerification(verify({ classification: 'verified' }))
    assert.deepEqual(outcome, { kind: 'install', trustToken: 'token-from-verify' })
  }

  {
    // Community → trust prompt populated with the REAL verified permissions.
    const outcome = classifyVerification(
      verify({
        classification: 'community',
        permissions: ['network', 'filesystem:read-workspace'],
        keyFingerprint: 'f'.repeat(64),
        pin: { manifestSha256: 'b'.repeat(64), componentDigests: {} },
      }),
    )
    assert.equal(outcome.kind, 'needs-trust')
    if (outcome.kind !== 'needs-trust') throw new Error('unreachable')
    assert.equal(outcome.trustToken, 'token-from-verify')
    assert.deepEqual(outcome.review, {
      classification: 'community',
      permissions: ['network', 'filesystem:read-workspace'],
      sourceUrl: 'https://github.com/sprintengine/studio-releases/tree/main/plugins/x',
      keyFingerprint: 'f'.repeat(64),
    })
  }

  {
    // No token, no prompt: main declined to issue an approval, so there is
    // nothing the person could agree to.
    const outcome = classifyVerification(verify({ classification: 'community', trustToken: undefined }))
    assert.equal(outcome.kind, 'blocked')
  }

  {
    // Community with no declared permissions: a real empty list, never fabricated.
    const outcome = classifyVerification(verify({ classification: 'community', permissions: [] }))
    assert.equal(outcome.kind, 'needs-trust')
    if (outcome.kind !== 'needs-trust') throw new Error('unreachable')
    assert.deepEqual(outcome.review.permissions, [])
  }

  {
    // Invalid signature → hard block, no install path; verifier message + issues kept.
    const outcome = classifyVerification(
      verify({
        classification: 'invalid',
        message: 'Downloaded plugin bundle signature is invalid.',
        issues: [{ path: 'signature', message: 'Invalid signature.' }],
      }),
    )
    assert.equal(outcome.kind, 'blocked')
    if (outcome.kind !== 'blocked') throw new Error('unreachable')
    assert.equal(outcome.classification, 'invalid')
    assert.match(outcome.message, /invalid/i)
    assert.deepEqual(outcome.issues, ['Invalid signature.'])
  }

  {
    // Unsigned → trust prompt per the T4b/T5 split: a bundle's components are
    // declarative and may install unsigned behind an explicit trust grant, with real permissions.
    const outcome = classifyVerification(
      verify({ classification: 'unsigned', permissions: ['filesystem:read-workspace'] }),
    )
    assert.equal(outcome.kind, 'needs-trust')
    if (outcome.kind !== 'needs-trust') throw new Error('unreachable')
    assert.deepEqual(outcome.review.permissions, ['filesystem:read-workspace'])
  }

  // --- summarizeInstallResult ------------------------------------------------

  {
    const ok: MarketplacePluginRegistryInstallResult = {
      ok: true,
      id: 'x',
      displayName: 'X',
      version: 1,
      trust: 'trusted',
      loadEligible: true,
      installed: [],
      classification: 'verified',
      sourceUrl: 'https://example.com',
      updated: false,
    }
    assert.deepEqual(summarizeInstallResult(ok), { status: 'installed', updated: false })

    const updated: MarketplacePluginRegistryInstallResult = { ...ok, updated: true }
    assert.deepEqual(summarizeInstallResult(updated), { status: 'installed', updated: true })

    // Skills that shipped without content ride through as notices.
    const withNotices: MarketplacePluginRegistryInstallResult = {
      ...ok,
      notices: ['1 skill (capped) ships without bundled content and was not installed.'],
    }
    assert.deepEqual(summarizeInstallResult(withNotices), {
      status: 'installed',
      updated: false,
      notices: ['1 skill (capped) ships without bundled content and was not installed.'],
    })
  }

  // The installed notice says what happened, and keeps the warn tone a partial
  // skill install puts on it.
  {
    const fresh = deriveInstallView({ status: 'installed', updated: false })
    assert.deepEqual(fresh.notice, { tone: 'good', message: 'Installed.' })
    assert.equal(fresh.action, null)
    assert.equal(fresh.busy, false)

    const updated = deriveInstallView({ status: 'installed', updated: true })
    assert.deepEqual(updated.notice, { tone: 'good', message: 'Updated to the latest version.' })

    const partial = deriveInstallView({ status: 'installed', updated: false, notices: ['skill X was not installed.'] })
    assert.equal(partial.notice?.tone, 'warn')
    assert.equal(partial.notice?.message, 'Installed.')
    assert.deepEqual(partial.notice?.issues, ['skill X was not installed.'])
  }

  {
    // A reachable failure with no signature re-classification stays retryable.
    const failed: MarketplacePluginRegistryInstallResult = {
      ok: false,
      message: 'Could not write skill files.',
      issues: [{ path: 'skills', message: 'permission denied' }],
    }
    const state = summarizeInstallResult(failed)
    assert.equal(state.status, 'error')
    if (state.status !== 'error') throw new Error('unreachable')
    assert.equal(state.message, 'Could not write skill files.')
    assert.deepEqual(state.issues, ['permission denied'])
  }

  {
    // The install lifecycle can re-verify at its final download step and report an
    // invalid signature: that is a hard block (no retry), not a retryable error.
    const invalid: MarketplacePluginRegistryInstallResult = {
      ok: false,
      classification: 'invalid',
      message: 'Downloaded plugin bundle signature is invalid.',
      issues: [{ path: 'signature', message: 'Invalid signature.' }],
    }
    const state = summarizeInstallResult(invalid)
    assert.equal(state.status, 'blocked', 'invalid install result hard-blocks')
    if (state.status !== 'blocked') throw new Error('unreachable')
    assert.equal(state.classification, 'invalid')
    assert.match(state.message, /invalid/i)
    assert.deepEqual(state.issues, ['Invalid signature.'])
    // No install/retry affordance is offered on the hard block.
    assert.equal(deriveInstallView(state).action, null)
  }

  {
    // Same hard block when the install step reports an unsigned bundle, with a
    // fallback message when the lifecycle omits one.
    const unsigned: MarketplacePluginRegistryInstallResult = {
      ok: false,
      classification: 'unsigned',
      message: '',
    }
    const state = summarizeInstallResult(unsigned)
    assert.equal(state.status, 'blocked', 'unsigned install result hard-blocks')
    if (state.status !== 'blocked') throw new Error('unreachable')
    assert.equal(state.classification, 'unsigned')
    assert.ok(state.message.length > 0, 'falls back to a default unsigned message')
    assert.equal(deriveInstallView(state).action, null)
  }

  // --- deriveInstallView: all seven states -----------------------------------

  {
    const v = deriveInstallView({ status: 'idle' })
    assert.deepEqual(v.action, { kind: 'install', label: 'Install' })
    assert.equal(v.busy, false)
    assert.equal(v.trustPrompt, false)
    assert.equal(v.notice, null)
  }

  {
    const v = deriveInstallView({ status: 'verifying' })
    assert.equal(v.action, null)
    assert.equal(v.busy, true)
    assert.equal(v.busyLabel, 'Verifying…')
  }

  {
    const v = deriveInstallView({
      status: 'needs-trust',
      review: { classification: 'community', permissions: ['network'] },
      trustToken: 'token-from-verify',
    })
    assert.deepEqual(v.action, { kind: 'trust-install', label: 'Trust and install' })
    assert.equal(v.trustPrompt, true)
    assert.deepEqual(v.review?.permissions, ['network'])
    assert.equal(v.trustToken, 'token-from-verify')
    assert.equal(v.busy, false)
  }

  {
    const v = deriveInstallView({ status: 'installing' })
    assert.equal(v.action, null)
    assert.equal(v.busy, true)
    assert.equal(v.busyLabel, 'Installing…')
  }

  {
    const fresh = deriveInstallView({ status: 'installed', updated: false })
    assert.equal(fresh.action, null)
    assert.equal(fresh.notice?.tone, 'good')
    assert.match(fresh.notice?.message ?? '', /Installed/)

    const bumped = deriveInstallView({ status: 'installed', updated: true })
    assert.match(bumped.notice?.message ?? '', /Updated/)

    // Metadata-only skills turn the success notice to a warn tone carrying the gap.
    const partial = deriveInstallView({ status: 'installed', updated: false, notices: ['skill X was not installed.'] })
    assert.equal(partial.notice?.tone, 'warn')
    assert.deepEqual(partial.notice?.issues, ['skill X was not installed.'])
  }

  {
    // Blocked: NO action (no install affordance), notice carries the reason.
    const invalid = deriveInstallView({
      status: 'blocked',
      classification: 'invalid',
      message: 'bad sig',
      issues: ['x'],
    })
    assert.equal(invalid.action, null, 'invalid blocked offers no install affordance')
    assert.equal(invalid.notice?.tone, 'error')
    assert.deepEqual(invalid.notice?.issues, ['x'])

    const unsigned = deriveInstallView({ status: 'blocked', classification: 'unsigned', message: 'no sig' })
    assert.equal(unsigned.action, null, 'unsigned blocked offers no install affordance')
    assert.equal(unsigned.notice?.tone, 'warn')
  }

  {
    // Error: retry is offered (distinct from a hard block).
    const v = deriveInstallView({ status: 'error', message: 'network down' })
    assert.deepEqual(v.action, { kind: 'retry', label: 'Try again' })
    assert.equal(v.notice?.tone, 'error')
    assert.equal(v.notice?.message, 'network down')
  }

  // Exhaustiveness guard: deriveInstallView returns a view for every state shape.
  const allStates: InstallFlowState[] = [
    { status: 'idle' },
    { status: 'verifying' },
    { status: 'needs-trust', review: { classification: 'unsigned', permissions: [] }, trustToken: 't' },
    { status: 'installing' },
    { status: 'installed', updated: false },
    { status: 'blocked', classification: 'invalid', message: 'm' },
    { status: 'error', message: 'm' },
  ]
  for (const state of allStates) {
    const v = deriveInstallView(state)
    assert.ok('action' in v && 'busy' in v && 'notice' in v, `state ${state.status} derives a complete view`)
  }

  {
    // A Claude Code plugin verify (unsigned skills payload) carries its real
    // skill file listing into the trust prompt, and the view exposes it.
    const outcome = classifyVerification(
      verify({ classification: 'unsigned', permissions: [], files: ['skills/hf-cli', 'skills/hf-datasets'] }),
    )
    assert.equal(outcome.kind, 'needs-trust')
    if (outcome.kind === 'needs-trust') {
      assert.deepEqual(outcome.review.files, ['skills/hf-cli', 'skills/hf-datasets'])
      const view = deriveInstallView({ status: 'needs-trust', review: outcome.review, trustToken: outcome.trustToken })
      assert.equal(view.trustPrompt, true)
      assert.deepEqual(view.review?.files, ['skills/hf-cli', 'skills/hf-datasets'])
    }
    // Permission-shaped trust prompts expose no file listing.
    const permView = deriveInstallView({
      status: 'needs-trust',
      review: { classification: 'community', permissions: [] },
      trustToken: 't',
    })
    assert.equal(permView.review?.files, undefined)
    // Outside the prompt there is nothing to disclose and nothing to spend.
    assert.equal(deriveInstallView({ status: 'idle' }).review, null)
    assert.equal(deriveInstallView({ status: 'idle' }).trustToken, null)
  }

  // --- installNeedsWorkspace -------------------------------------------------
  // A Claude Code plugin's skills write into a project; the inline-CLI lane does not.
  {
    assert.equal(installNeedsWorkspace(['cli']), false)
    assert.equal(installNeedsWorkspace(['skills']), true)
    assert.equal(installNeedsWorkspace([]), false)
  }

  console.log('installFlow.test.ts passed')
})
