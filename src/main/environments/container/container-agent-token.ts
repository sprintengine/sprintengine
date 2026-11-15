import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { openSecret, sealSecret, type SecretCipher } from '../../../server/platform/secret-cipher'

// Claude Code's sign-in for chats in containers (docs/design/container-chats.md):
// a long-lived token the person makes once on their own computer with
// `claude setup-token`, kept here sealed with the app's cipher (the system
// keychain on a desktop), and handed to a container's Studio server when it
// starts, as the CLI's own `CLAUDE_CODE_OAUTH_TOKEN`. It is the agent's login
// and nothing else: no git or GitHub credential goes with it.
//
// Never logged, never in a command line (the docker CLI takes it from its own
// environment, `docker exec -e NAME`), never in an image or a container's
// saved config. A cipher that is not available keeps it for the session only.

export const CLAUDE_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN'

/** What `claude setup-token` prints, and an API key: `sk-ant-` and plain token characters. */
const TOKEN = /^sk-ant-[A-Za-z0-9_-]{20,400}$/u

import type { ContainerTokenStatus } from '../../../shared/containers'

export class ContainerAgentToken {
  private cached: string | null | undefined
  private sessionOnly = false

  constructor(
    private readonly deps: {
      path: string
      cipher: SecretCipher
    },
  ) {}

  /** The token, or null; read once and kept in memory after. */
  async value(): Promise<string | null> {
    if (this.cached !== undefined) return this.cached
    try {
      const sealed = await readFile(this.deps.path)
      this.cached = (await openSecret(this.deps.cipher, sealed)).trim() || null
    } catch {
      this.cached = null
    }
    return this.cached
  }

  /** The token as last read, without waiting: what a session spawned now is given. Call `value()` once at start. */
  current(): string | null {
    return this.cached ?? null
  }

  async status(): Promise<ContainerTokenStatus> {
    const set = (await this.value()) !== null
    return { set, kept: set ? (this.sessionOnly ? 'session' : 'sealed') : null }
  }

  async set(input: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const token = input.trim()
    if (!TOKEN.test(token))
      return {
        ok: false,
        message: 'That does not look like a token from claude setup-token. It starts with sk-ant-.',
      }
    this.cached = token
    if (!this.deps.cipher.available()) {
      this.sessionOnly = true
      return { ok: true }
    }
    await mkdir(dirname(this.deps.path), { recursive: true })
    const staged = `${this.deps.path}.${process.pid}`
    await writeFile(staged, await sealSecret(this.deps.cipher, token), { mode: 0o600 })
    await rename(staged, this.deps.path)
    this.sessionOnly = false
    return { ok: true }
  }

  async clear(): Promise<void> {
    this.cached = null
    this.sessionOnly = false
    await unlink(this.deps.path).catch(() => undefined)
  }
}
