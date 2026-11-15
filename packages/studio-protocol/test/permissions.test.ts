import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  STUDIO_METHODS,
  STUDIO_METHOD_ACCESS,
  STUDIO_TOPICS,
  STUDIO_TOPIC_ACCESS,
  authorizeStudioMethod,
  authorizeStudioTopic,
  studioGrantAllows,
  studioGrantAllowsTopic,
  studioRefusedGrantName,
  studioSpecPermissions,
  type StudioMethod,
  type StudioTopic,
} from '../src/methods'
import {
  STUDIO_PERMISSIONS,
  STUDIO_SCOPE_PERMISSIONS,
  authorizeStudioAccess,
  isStudioPermission,
  studioAccessFor,
  studioGrantPrincipal,
  studioPrincipal,
  studioScopeRequires,
  type StudioAccess,
} from '../src/permissions'
import { STUDIO_SCOPES, type StudioScope } from '../src/scopes'

// The check as it stood before permissions, frozen here as the oracle the new
// one must agree with: a scope covers itself, and operate covers read.
function legacyStudioScopesGrant(scopes: readonly string[], needed: StudioScope): boolean {
  if (scopes.includes(needed)) return true
  if (needed === 'backlog:read') return scopes.includes('backlog:operate')
  if (needed === 'modules:read') return scopes.includes('modules:operate')
  // `workspaces:operate` (the scheduled agents) carries its read, as the others do.
  if (needed === 'workspaces:read') return scopes.includes('workspaces:operate')
  return needed === 'conversation:read' && scopes.includes('conversation:operate')
}
/** The scope whose grant name a permission is, for a method that needs more than its own scope. */
function scopeNaming(permission: string): StudioScope {
  const scope = STUDIO_SCOPES.find((candidate) => studioScopeRequires(candidate).includes(permission as never))
  assert.ok(scope, `a scope names ${permission}`)
  return scope
}
function legacyAllows(
  grant: { owner: boolean; scopes: StudioScope[] },
  spec: { scope: StudioScope | null; owner?: string; extraPermissions?: readonly string[] },
) {
  if (spec.owner && !grant.owner) return false
  if (spec.scope !== null && !legacyStudioScopesGrant(grant.scopes, spec.scope)) return false
  return (spec.extraPermissions ?? []).every((permission) =>
    legacyStudioScopesGrant(grant.scopes, scopeNaming(permission)),
  )
}

type Grant = { owner: boolean; scopes: StudioScope[] }

function* scopeSubsets(): Generator<StudioScope[]> {
  for (let mask = 0; mask < 1 << STUDIO_SCOPES.length; mask++)
    yield STUDIO_SCOPES.filter((_scope, index) => (mask & (1 << index)) !== 0)
}

/** Every method and topic: its name, its spec, the access table's row, and the server's own check of it. */
const ENTRIES = [
  ...(Object.keys(STUDIO_METHODS) as StudioMethod[]).map((name) => ({
    name,
    spec: STUDIO_METHODS[name],
    access: STUDIO_METHOD_ACCESS[name],
    decide: (grant: Grant) => authorizeStudioMethod(grant, name).ok,
  })),
  ...(Object.keys(STUDIO_TOPICS) as StudioTopic[]).map((name) => ({
    name: `topic ${name}`,
    spec: STUDIO_TOPICS[name],
    access: STUDIO_TOPIC_ACCESS[name],
    decide: (grant: Grant) => authorizeStudioTopic(grant, name).ok,
  })),
]

/**
 * The every-grant checks, in slices of the sets of scopes so that no one test
 * nears the time limit as method families are added: at 15 scopes they are
 * 65,536 grants by every method and topic.
 */
const SLICES = 16
const holding = (grant: Grant) => `${grant.owner ? 'an owner' : 'a client'} holding [${grant.scopes.join(', ')}]`

test('the permission set is closed: each name once, and nothing outside it is one', () => {
  assert.equal(new Set(STUDIO_PERMISSIONS).size, STUDIO_PERMISSIONS.length)
  for (const permission of STUDIO_PERMISSIONS) assert.equal(isStudioPermission(permission), true, permission)
  for (const value of ['conversation:admin', 'terminal:observe', 'files:read', '', null, 7, 'constructor'])
    assert.equal(isStudioPermission(value), false, String(value))
})

test('every method and topic needs the permission its scope names, never less, and only names from the set', () => {
  for (const [name, spec] of [...Object.entries(STUDIO_METHODS), ...Object.entries(STUDIO_TOPICS)]) {
    const needed = studioSpecPermissions(spec)
    for (const permission of needed) assert.equal(isStudioPermission(permission), true, `${name}: ${permission}`)
    for (const permission of spec.extraPermissions ?? [])
      assert.equal(isStudioPermission(permission), true, `${name}: ${permission}`)
    // A method with a scope needs that scope's permission, whatever it adds;
    // only the two that any authenticated client may ask need none.
    if (spec.scope === null) assert.deepEqual(needed, [], name)
    else {
      for (const own of studioScopeRequires(spec.scope))
        assert.ok(needed.includes(own), `${name} needs what "${spec.scope}" names`)
    }
  }
  assert.deepEqual(studioSpecPermissions(STUDIO_METHODS['server.info']), [])
  assert.deepEqual(studioSpecPermissions(STUDIO_METHODS['server.ping']), [])
})

test('a permission a method adds beyond its scope is needed too, and its refusal names it', () => {
  const spec = { scope: 'conversation:operate' as const, extraPermissions: ['filesystem:write' as const] }
  assert.deepEqual(studioSpecPermissions(spec), ['conversation:operate', 'filesystem:write'])
  assert.deepEqual(studioSpecPermissions({ ...spec, extraPermissions: ['conversation:operate'] }), [
    'conversation:operate',
  ])
  // Today's refusals name the scope, as they always have.
  assert.equal(studioRefusedGrantName(spec, 'conversation:operate'), 'conversation:operate')
  assert.equal(studioRefusedGrantName({ scope: 'files:read' }, 'filesystem:read'), 'files:read')
  assert.equal(studioRefusedGrantName(spec, 'filesystem:write'), 'filesystem:write')
  // What needs more than its scope: a chat's app toolsets are the client
  // tools' (`tools:offer`), and opening a chat to one is a setting.
  const needingMore = [...Object.entries(STUDIO_METHODS), ...Object.entries(STUDIO_TOPICS)]
    .filter(([, method]) => method.extraPermissions !== undefined)
    .map(([name, method]) => [name, method.extraPermissions])
  assert.deepEqual(needingMore, [
    ['tools.grants', ['tools:offer']],
    ['tools.grant', ['settings:write']],
  ])
  assert.equal(studioRefusedGrantName(STUDIO_METHODS['tools.grant'], 'settings:write'), 'settings:write')
})

test('every Studio scope a grant can hold carries only permissions from the closed set', () => {
  for (const scope of STUDIO_SCOPES) {
    assert.ok(STUDIO_SCOPE_PERMISSIONS[scope].length > 0, scope)
    for (const permission of STUDIO_SCOPE_PERMISSIONS[scope]) assert.equal(isStudioPermission(permission), true, scope)
  }
  // Nothing a grant made today holds reaches this machine's terminals (an
  // owner's only, by no scope); who may reach this machine is an owner's by
  // method, with no permission of its own; this machine's upkeep (updating it)
  // and its settings only through the scope that names each.
  const carried = new Set<string>(STUDIO_SCOPES.flatMap((scope) => STUDIO_SCOPE_PERMISSIONS[scope]))
  for (const permission of carried) assert.equal(permission.startsWith('terminal:'), false, permission)
  assert.equal(isStudioPermission('terminal:read'), false)
  assert.equal(isStudioPermission('terminal:operate'), false)
  for (const named of ['environment:maintain', 'settings:write'] as const)
    for (const scope of STUDIO_SCOPES)
      assert.equal(STUDIO_SCOPE_PERMISSIONS[scope].includes(named), scope === named, `${named} in ${scope}`)
})

// Two checks of every grant against every method and topic, made in one pass
// so the server's own check is asked once for each, not once per check:
// - every grant reaches exactly the methods and topics it reached before
//   permissions (the frozen oracle above);
// - the access tables a client reads say what the server decides.
// Each row is compared; its words are written only for a row that differs.
/** The sets of scopes a slice takes (every `SLICES`th), and so the rows it compares. */
const setsInSlice = (slice: number) => Math.ceil(((1 << STUDIO_SCOPES.length) - slice) / SLICES)
for (let slice = 0; slice < SLICES; slice++)
  test(`every grant reaches what it reached before permissions, and the access tables say what the server decides (${slice + 1} of ${SLICES})`, () => {
    let index = 0
    let compared = 0
    for (const scopes of scopeSubsets()) {
      if (index++ % SLICES !== slice) continue
      for (const owner of [false, true]) {
        const grant = { owner, scopes }
        const principal = studioGrantPrincipal(grant)
        for (const entry of ENTRIES) {
          const server = entry.decide(grant)
          const before = legacyAllows(grant, entry.spec)
          if (server !== before) assert.equal(server, before, `${entry.name} for ${holding(grant)}`)
          const shown = authorizeStudioAccess(principal, entry.access).ok
          if (shown !== server) assert.equal(shown, server, `${entry.name}'s table for ${holding(grant)}`)
          compared++
        }
      }
    }
    assert.equal(compared, setsInSlice(slice) * 2 * ENTRIES.length)
  })

test('the slices take every set of scopes once, so every grant is compared against every method and topic', () => {
  let sets = 0
  for (let slice = 0; slice < SLICES; slice++) sets += setsInSlice(slice)
  assert.equal(sets, 1 << STUDIO_SCOPES.length)
  assert.ok(sets * 2 * ENTRIES.length > 256 * 2 * 50)
})

test('the access tables a client reads name every method and topic, and refuse what is no method', () => {
  assert.deepEqual(Object.keys(STUDIO_METHOD_ACCESS).sort(), Object.keys(STUDIO_METHODS).sort())
  assert.deepEqual(Object.keys(STUDIO_TOPIC_ACCESS).sort(), Object.keys(STUDIO_TOPICS).sort())
  const owner = { owner: true, scopes: [...STUDIO_SCOPES] }
  for (const name of ['conversation.compact', 'constructor', '__proto__', '']) {
    assert.equal(studioGrantAllows(owner, name), false, name)
    assert.equal(studioGrantAllowsTopic(owner, name), false, name)
  }
  assert.equal(studioGrantAllows(owner, 'conversation.send'), true)
  assert.equal(studioGrantAllows({ owner: false, scopes: ['conversation:read'] }, 'conversation.send'), false)
  assert.equal(studioGrantAllowsTopic({ owner: false, scopes: ['conversation:read'] }, 'conversation.session'), true)
})

test('an unknown method is refused, and so is a name only the prototype has', () => {
  const owner = studioPrincipal({ owner: true, permissions: STUDIO_PERMISSIONS })
  assert.deepEqual(authorizeStudioAccess(owner, undefined), { ok: false, reason: 'unknown_method' })
  // A table of access, as the tailnet's and the tunnel's are: own keys only.
  const table: Readonly<Record<string, StudioAccess>> = {
    'conversation.send': { permissions: ['conversation:operate'] },
  }
  for (const name of ['conversation.compact', 'constructor', '__proto__', 'toString', 'hasOwnProperty', ''])
    assert.equal(studioAccessFor(table, name), undefined, name)
  assert.equal(authorizeStudioAccess(owner, studioAccessFor(table, 'constructor')).ok, false)
  assert.equal(studioAccessFor(table, 'conversation.send'), table['conversation.send'])
  // The method and topic tables are judged through their own authorizers.
  const grant = { owner: true, scopes: [...STUDIO_SCOPES] }
  for (const name of ['conversation.compact', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '']) {
    assert.deepEqual(authorizeStudioMethod(grant, name), { ok: false, reason: 'unknown_method' }, name)
    assert.deepEqual(authorizeStudioTopic(grant, name), { ok: false, reason: 'unknown_method' }, name)
  }
  assert.deepEqual(authorizeStudioMethod(grant, 'conversation.send'), { ok: true })
})

test('the decision: local-only before owner, owner before permissions, the first missing permission named', () => {
  const nobody = studioPrincipal({ owner: false, permissions: [] })
  const everyone = studioPrincipal({ owner: true, permissions: STUDIO_PERMISSIONS })
  const localOnly: StudioAccess = { localOnly: 'Run it on that machine.' }
  assert.deepEqual(authorizeStudioAccess(everyone, localOnly), {
    ok: false,
    reason: 'local_only',
    message: 'Run it on that machine.',
  })
  const owned: StudioAccess = { permissions: ['conversation:operate'], owner: 'Only an owner may.' }
  assert.deepEqual(authorizeStudioAccess(nobody, owned), { ok: false, reason: 'owner_required' })
  assert.deepEqual(
    authorizeStudioAccess(studioPrincipal({ owner: false, permissions: STUDIO_PERMISSIONS }), owned),
    { ok: false, reason: 'owner_required' },
    'every permission is still not the owner',
  )
  const both: StudioAccess = { permissions: ['conversation:read', 'conversation:operate'] }
  assert.deepEqual(authorizeStudioAccess(nobody, both), {
    ok: false,
    reason: 'permission_required',
    permission: 'conversation:read',
  })
  assert.deepEqual(authorizeStudioAccess(studioPrincipal({ owner: false, permissions: ['conversation:read'] }), both), {
    ok: false,
    reason: 'permission_required',
    permission: 'conversation:operate',
  })
  assert.deepEqual(authorizeStudioAccess(nobody, { permissions: [] }), { ok: true })
})

test('a grant is translated by its scopes alone: unknown names carry nothing, and nothing is implied later', () => {
  const principal = studioGrantPrincipal({ owner: false, scopes: ['conversation:operate', 'terminal:observe', 'x'] })
  assert.deepEqual([...principal.permissions].sort(), ['conversation:operate', 'conversation:read'])
  assert.equal(principal.owner, false)
  assert.deepEqual([...studioGrantPrincipal({ owner: true, scopes: [] }).permissions], [])
  // A principal built from names outside the set holds none of them.
  assert.deepEqual([...studioPrincipal({ owner: false, permissions: ['nope' as never] }).permissions], [])
})
