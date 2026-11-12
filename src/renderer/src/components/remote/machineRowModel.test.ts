import assert from 'node:assert/strict'

import { platformLabel, shortMachineName } from './machineRowModel'
import { test } from 'vitest'

test('machineRowModel', async () => {
  // A machine row's name and platform word. How a machine stands is
  // `src/shared/environment-status.test.ts`'s.

  assert.equal(shortMachineName('sam-macbook-air.tailabc.ts.net'), 'sam-macbook-air')
  assert.equal(shortMachineName('100.64.0.101'), '100.64.0.101')

  // The platform word: every spelling the four sources use, and null for the
  // ones that say nothing a person would recognise.
  assert.equal(platformLabel('macOS'), 'macOS')
  assert.equal(platformLabel('darwin'), 'macOS')
  // 'darwin' contains 'win', so the macOS test has to come first or every Mac
  // on the tailnet reads as a Windows box.
  assert.equal(platformLabel('windows'), 'Windows')
  assert.equal(platformLabel('win32'), 'Windows')
  assert.equal(platformLabel('linux'), 'Linux')
  assert.equal(platformLabel('android'), 'Android')
  assert.equal(platformLabel('iOS'), 'iOS')
  assert.equal(platformLabel(null), null)
  assert.equal(platformLabel(''), null)
  assert.equal(platformLabel('plan9'), null)

  console.log('machineRowModel.test.ts: machine row contracts ok')
})
