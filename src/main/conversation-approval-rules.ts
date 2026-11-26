import { realpath } from 'fs/promises'
import { dirname, resolve } from 'path'
import { randomUUID } from 'crypto'
import type { StudioDatabase } from '../server/db/database'
import { STUDIO_MCP_SERVER_ID } from '../shared/product-identity'
import type { ConversationApprovalDecision } from '../shared/conversation-runtime'
import {
  approvalFilePath,
  approvalRuleCandidate,
  isApprovalPathInGitDirectory,
  isPathWithinApprovalRoot,
  matchesApprovalRule,
  migrateConversationApprovalRule,
  type ApprovalRuleRequest,
  type ConversationApprovalRule,
} from '../shared/conversation/approvalRules'

/** The file builds before the database kept the rules in, under the data folder; read once, by the import. */
export const APPROVAL_RULES_FILENAME = 'conversation-approval-rules.json'

/**
 * Grants live in the data folder's database (`approval_rules`, in the order
 * they were made), never in a repository-controlled sidecar. A rule a chat
 * keeps for its session only is held here in memory.
 */
export class ConversationApprovalRuleStore {
  private persistent: ConversationApprovalRule[] = []
  private sessions = new Map<string, ConversationApprovalRule[]>()
  private loaded?: Promise<void>
  private writes: Promise<void> = Promise.resolve()
  constructor(private readonly database?: StudioDatabase) {}
  private async load(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.database) return
      const rows = await this.database.all<{ body: string }>('SELECT body FROM approval_rules ORDER BY rowid')
      const saved = rows.map((row): unknown => {
        try {
          return JSON.parse(row.body)
        } catch {
          return null
        }
      })
      const rules = saved.map(migrateConversationApprovalRule)
      this.persistent = rules.filter((rule) => rule !== null)
      // Narrowed or dropped grants are written back at once, so nothing
      // reading the rules later can revive the wider scope.
      if (rules.some((rule, index) => rule !== saved[index])) await this.save(this.persistent)
    })()
    return this.loaded
  }
  async list(workspaceRoot?: string): Promise<ConversationApprovalRule[]> {
    await this.load()
    return this.persistent
      .filter((rule) => !workspaceRoot || rule.workspaceRoot === workspaceRoot)
      .map((rule) => ({ ...rule, matcher: { ...rule.matcher } }))
  }
  async match(
    workspaceRoot: string,
    sessionId: string,
    request: ApprovalRuleRequest,
  ): Promise<ConversationApprovalRule | null> {
    await this.load()
    const rule = [...(this.sessions.get(sessionId) ?? []), ...this.persistent].find((entry) =>
      matchesApprovalRule(entry, request, workspaceRoot),
    )
    if (!rule || !(await safeFileScope(request, workspaceRoot))) return null
    return rule
  }
  async remember(
    workspaceRoot: string,
    sessionId: string,
    request: ApprovalRuleRequest,
    scope: Extract<ConversationApprovalDecision, 'conversation' | 'always'>,
  ): Promise<ConversationApprovalRule> {
    await this.load()
    const candidate = approvalRuleCandidate(request, workspaceRoot)
    if (!candidate || !(await safeFileScope(request, workspaceRoot)))
      throw new Error('This request can only be allowed once.')
    const rule = { ...candidate, id: randomUUID(), createdAt: Date.now() }
    if (scope === 'conversation')
      this.sessions.set(sessionId, [
        ...(this.sessions.get(sessionId) ?? []).filter((entry) => !matchesApprovalRule(entry, request, workspaceRoot)),
        rule,
      ])
    else {
      if (!this.database) throw new Error('Persistent conversation permissions are unavailable.')
      await this.mutate((rules) => [
        ...rules.filter((entry) => !matchesApprovalRule(entry, request, workspaceRoot)),
        rule,
      ])
    }
    return rule
  }
  /**
   * Keep a saved rule as another Studio kept it (a desktop handing over the
   * chats it ran in this machine's folders), held to what a rule saved here
   * may be. One whose id is here already is left as this store has it.
   */
  async adopt(value: unknown): Promise<{ ok: true } | { ok: false; reason: string; exists?: true }> {
    await this.load()
    if (!this.database) return { ok: false, reason: 'Persistent conversation permissions are unavailable.' }
    const rule = migrateConversationApprovalRule(value)
    // Kept only as it was given: one this build would narrow comes back as
    // another object (as `load` reads it), and is not this rule.
    if (!rule || rule !== value) return { ok: false, reason: 'It is not a rule this Studio keeps.' }
    if (this.persistent.some((entry) => entry.id === rule.id))
      return { ok: false, reason: 'A rule with that id is already here.', exists: true }
    await this.mutate((rules) => (rules.some((entry) => entry.id === rule.id) ? rules : [...rules, rule]))
    return { ok: true }
  }
  async revoke(id: string): Promise<void> {
    await this.load()
    await this.mutate((rules) => rules.filter((rule) => rule.id !== id))
  }
  /**
   * Forget every rule that allows a tool of these client toolsets, on the
   * Studio gateway, saved or for a session: the toolsets' app was revoked, and
   * a later app that takes one of the names must inherit no "always allow".
   * A rule names the tool as the CLI spelled it (`game.spawn` or
   * `game_spawn`), and a toolset name has no underscore, so either splits at
   * its first separator.
   */
  async forgetGatewayToolsets(toolsets: readonly string[]): Promise<number> {
    if (toolsets.length === 0) return 0
    await this.load()
    const names = new Set(toolsets)
    const forgets = (rule: ConversationApprovalRule) => {
      if (rule.matcher.type !== 'mcp' || !rule.matcher.server.includes(STUDIO_MCP_SERVER_ID)) return false
      const toolset = /^([a-z][a-z0-9-]*)[._]/u.exec(rule.matcher.tool)?.[1]
      return toolset !== undefined && names.has(toolset)
    }
    for (const [sessionId, rules] of this.sessions)
      this.sessions.set(
        sessionId,
        rules.filter((rule) => !forgets(rule)),
      )
    const before = this.persistent.length
    if (this.database && this.persistent.some(forgets))
      await this.mutate((rules) => rules.filter((rule) => !forgets(rule)))
    return before - this.persistent.length
  }
  dropSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }
  private mutate(change: (rules: ConversationApprovalRule[]) => ConversationApprovalRule[]): Promise<void> {
    const write = this.writes
      .catch(() => undefined)
      .then(async () => {
        const next = change(this.persistent)
        await this.save(next)
        this.persistent = next
      })
    this.writes = write
    return write
  }
  /** The rules, whole, in one transaction: there are few, and their order is the order they were made. */
  private async save(rules: ConversationApprovalRule[]): Promise<void> {
    if (!this.database) throw new Error('Persistent conversation permissions are unavailable.')
    await this.database.batch([
      { sql: 'DELETE FROM approval_rules' },
      ...rules.map((rule) => ({
        sql: 'INSERT INTO approval_rules (id, workspace_root, body) VALUES (?, ?, ?)',
        params: [rule.id, rule.workspaceRoot, JSON.stringify(rule)],
      })),
    ])
  }
}

async function safeFileScope(request: ApprovalRuleRequest, workspaceRoot: string): Promise<boolean> {
  const candidate = approvalRuleCandidate(request, workspaceRoot)
  if (!candidate) return false
  if (candidate.matcher.type !== 'path') return true
  const path = approvalFilePath(request, workspaceRoot)
  if (!path) return false
  try {
    const root = await realpath(workspaceRoot)
    let existing = resolve(path)
    // A Write may name a file or several parent directories that do not exist.
    // Resolve the first existing ancestor; a symlink there must stay in scope.
    for (;;) {
      try {
        const real = await realpath(existing)
        // A symlink inside the workspace may point into its git directory.
        return isPathWithinApprovalRoot(real, root) && !isApprovalPathInGitDirectory(real, root)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(existing) === existing) return false
        existing = dirname(existing)
      }
    }
  } catch {
    return false
  }
}
