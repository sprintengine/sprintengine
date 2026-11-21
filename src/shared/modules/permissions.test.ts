import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  EXTENSION_PERMISSIONS,
  capabilityAccess,
  describeCapabilityPermission,
  extensionApprovalCopy,
  isBroadCapabilityPermission,
  isKnownCapabilityPermission,
  partitionCapabilityAccess,
  validateCapabilityPermissions,
} from './permissions'

test('a bundle’s permissions validate structurally and dedupe; an unknown one is flagged', () => {
  const result = validateCapabilityPermissions(['storage:own', 'storage:own', 'totally-made-up'])
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.permissions, ['storage:own', 'totally-made-up'])
  assert.deepEqual(validateCapabilityPermissions(undefined), { ok: true, permissions: [] })
  assert.equal(validateCapabilityPermissions('storage:own').ok, false)
  const bad = validateCapabilityPermissions(['storage:own', 42])
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.equal(bad.issues[0]!.path, 'permissions[1]')
  assert.equal(isKnownCapabilityPermission('totally-made-up'), false)
  assert.match(describeCapabilityPermission('totally-made-up'), /Unrecognized/)
})

test('every permission in the vocabulary is described, and only reading every chat is broad', () => {
  for (const permission of EXTENSION_PERMISSIONS) {
    assert.equal(isKnownCapabilityPermission(permission), true)
    assert.doesNotMatch(describeCapabilityPermission(permission), /Unrecognized/, permission)
    assert.equal(isBroadCapabilityPermission(permission), permission === 'conversation:read', permission)
  }
  assert.match(describeCapabilityPermission('github:api'), /never shown/)
  assert.match(describeCapabilityPermission('secrets:own'), /never shown/)
  // The names the vocabulary replaced are not permissions any more.
  for (const retired of ['module:bridge', 'ipc:invoke', 'network', 'process:spawn', 'storage', 'mcp:tools'])
    assert.equal(isKnownCapabilityPermission(retired), false, retired)
})

test('the approval says what each tier’s code can do, as this build enforces it', () => {
  // A worker's code runs as the person: said plainly.
  assert.match(extensionApprovalCopy('worker'), /on this machine with full access/)
  assert.match(extensionApprovalCopy('worker'), /its own code is not limited/)
  // A ui extension's code runs in sandboxed frames: what it is allowed is all it can do.
  assert.match(extensionApprovalCopy('ui'), /runs isolated and can do only what you allow/)
  assert.doesNotMatch(extensionApprovalCopy('ui'), /full access/)
  assert.match(extensionApprovalCopy('declarative'), /runs no code of its own/)
  assert.match(extensionApprovalCopy('content'), /runs nothing/)
})

// The at-a-glance table Settings → Extensions draws its warning glyphs from.
// One row per permission, so one added to the vocabulary without a short
// title fails here rather than reaching a row as "Unrecognized".
const NEEDS_CARE = [
  'workspace:operate',
  'conversation:read',
  'conversation:own',
  'conversation:bypass',
  'github:api',
  'secrets:own',
  'usage:read',
  'backlog:operate',
  'workspace-files:write',
]

test('every permission has a short title, and exactly the sensitive ones need care', () => {
  for (const permission of EXTENSION_PERMISSIONS) {
    const access = capabilityAccess(permission)
    assert.doesNotMatch(access.title, /Unrecognized/, `${permission} has a title of its own`)
    assert.ok(access.title.split(' ').length <= 6, `${permission}: "${access.title}" stays short`)
    assert.equal(access.care, NEEDS_CARE.includes(permission), `${permission} care flag`)
    if (access.care) {
      assert.ok(access.why, `${permission} says why it needs care`)
      assert.ok(access.why!.split(/\s+/).length <= 6, `${permission}: "${access.why}" is six words or fewer`)
    } else {
      assert.equal(access.why, undefined, `${permission} is standard and carries no why`)
    }
    assert.doesNotMatch(access.title, /…$/, 'no trailing ellipsis')
  }
})

test('an unrecognized permission always needs care and names itself', () => {
  const access = capabilityAccess('totally-made-up')
  assert.equal(access.care, true)
  assert.match(access.title, /totally-made-up/)
  assert.ok(access.why)
})

test('partitioning keeps declared order within each group', () => {
  assert.deepEqual(
    partitionCapabilityAccess(['storage:own', 'github:api', 'mystery:scope', 'backlog:read', 'conversation:own']),
    {
      care: ['github:api', 'mystery:scope', 'conversation:own'],
      standard: ['storage:own', 'backlog:read'],
    },
  )
  assert.deepEqual(partitionCapabilityAccess([]), { care: [], standard: [] })
})
