import assert from 'node:assert/strict'
import { test } from 'vitest'

import { classifyWslFailure, stageId } from './wsl-process'

test("wsl.exe's own failures are sorted into transient and fatal", () => {
  assert.equal(classifyWslFailure('WSL_E_DISTRO_NOT_FOUND', 1).code, 'distro-missing')
  assert.equal(classifyWslFailure('Windows Subsystem for Linux has no installed distributions.', 1).fatal, true)
  assert.equal(classifyWslFailure('WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED', 1).code, 'wsl-missing')
  assert.equal(classifyWslFailure('exec: node: not found', 127).code, 'node-run')
  const cold = classifyWslFailure('Catastrophic failure Error code: Wsl/Service/E_UNEXPECTED', 1)
  assert.equal(cold.fatal, false)
  assert.match(stageId(), /^[0-9a-f]{12}$/u)
})
