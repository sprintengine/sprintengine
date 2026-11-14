import assert from 'node:assert/strict'
import { test } from 'vitest'

import { STUDIO_METHODS, STUDIO_TOPICS, studioSpecPermissions } from '../../packages/studio-protocol/src/methods'
import { STUDIO_PERMISSIONS, type StudioAccess } from '../../packages/studio-protocol/src/permissions'
import { TAILNET_ROUTE_ACCESS, tailnetToolAccess } from '../main/automation/tailnet/tailnet-scopes'
import { WEB_HTTP_ACCESS, WEB_TUNNEL_ACCESS } from './web-tunnel-access'

// The permission set across every way into a Studio: each permission is one
// some method needs. A name nothing needs
// is a grant nobody can reason about.

test('every permission is needed by some remote method', () => {
  const declarations: StudioAccess[] = [
    ...[...Object.values(STUDIO_METHODS), ...Object.values(STUDIO_TOPICS)].map((spec) => ({
      permissions: studioSpecPermissions(spec),
    })),
    ...Object.values(TAILNET_ROUTE_ACCESS),
    ...Object.values(WEB_TUNNEL_ACCESS),
    ...Object.values(WEB_HTTP_ACCESS),
    // The tool rule's families, read and operate.
    ...['workspace.list', 'backlog.list', 'conversation.list'].flatMap((tool) => [
      tailnetToolAccess(tool, false),
      tailnetToolAccess(tool, true),
    ]),
  ]
  const needed = new Set(declarations.flatMap((access) => ('permissions' in access ? access.permissions : [])))
  for (const permission of STUDIO_PERMISSIONS)
    assert.equal(needed.has(permission), true, `${permission} is needed by nothing`)
})
