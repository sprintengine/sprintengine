import assert from 'node:assert/strict'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { deriveWorkspaceId, isWorkspaceIdToken, resolveWorkspaceIdToRoot } from './workspace-id'
import { validateMobileWorkspacePath } from './workspace'
import { test } from 'vitest'

test('workspace-id', async () => {
  // The same families of absolute path path-safety.ts redacts: a token carries none.
  const localPathProbe =
    /(?:\/Users\/|\/home\/|\/private\/|\/var\/folders\/|\/Volumes\/|\/Applications\/|\/Library\/|\/opt\/|\/srv\/|\/mnt\/|\/tmp\/|[A-Za-z]:\\|\\\\[^\\\s]+\\)/u

  const suiteRun = main()

  async function main(): Promise<void> {
    assertTokenRoundTrips()
    await assertValidateResolvesToken()
    console.log('workspace-id regression: all assertions passed')
  }

  function assertTokenRoundTrips(): void {
    const root = '/Users/example/workspace/projA'
    const token = deriveWorkspaceId(root)
    assert.equal(isWorkspaceIdToken(token), true)
    assert.equal(isWorkspaceIdToken(root), false)
    assert.equal(localPathProbe.test(token), false, 'token must carry no local path')
    assert.equal(resolveWorkspaceIdToRoot(token, [root]), resolve(root))
    // Stable: same root always hashes to the same token.
    assert.equal(deriveWorkspaceId(root), token)
    // Fail closed when no candidate matches.
    assert.equal(resolveWorkspaceIdToRoot(token, ['/Users/example/workspace/projB']), null)
    assert.equal(resolveWorkspaceIdToRoot('ws_notarealtoken', [root]), null)
  }

  async function assertValidateResolvesToken(): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'ws-id-'))
    const token = deriveWorkspaceId(root)
    const resolved = await validateMobileWorkspacePath({
      workspacePath: token,
      allowedWorkspaceRoots: [root],
    })
    assert.equal(resolved, resolve(root), 'a workspace token validates to its real root')

    // An unresolvable token fails closed rather than guessing.
    await assert.rejects(
      validateMobileWorkspacePath({ workspacePath: 'ws_unknownunknownunknown', allowedWorkspaceRoots: [root] }),
      /not available/u,
    )
  }

  await suiteRun
})
