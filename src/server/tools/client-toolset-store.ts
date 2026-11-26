import type { StudioDatabase } from '../db/database'
import { createRecordTable } from '../db/record-table'

import { STUDIO_TOOLSET_NAME_PATTERN } from '../../../packages/studio-protocol/src/public'

// Which client each app toolset name belongs to, and which conversations the
// person opened to it. A name is bound to a pairing the first time that
// pairing offers it, and another app that offers the same name is refused, so
// an agent that learned `game.spawn_enemy` from one app is never handed
// another app's tool under that name. The binding lasts as long as the
// pairing: revoking the app deletes it, with every conversation grant, so a
// later app that takes the name inherits nothing.
//
// Owner connections share one client id and so one set of bindings, which is
// right: an owner is the person. Built-in toolsets are never bound; they are
// the shell's.
//
// A row per toolset in the data folder's database (`client_toolsets`), read
// once at start.

/** The file builds before the database kept the bindings in, under the data folder; read once, by the import. */
export const CLIENT_TOOLSETS_FILENAME = 'client-toolsets.json'

const MAX_BINDINGS = 512
const MAX_GRANTS_PER_TOOLSET = 512

export type ConversationRef = { workspaceId: string; agentId: string }

export type ClientToolsetBinding = {
  toolset: string
  clientId: string
  /** The title the toolset was last offered under, for Settings and the origin labels. */
  title: string
  boundAt: string
  /** Conversations the person opened to this toolset (`tools.grant`). */
  conversations: ConversationRef[]
}

export type ClientToolsetStore = {
  binding(toolset: string): ClientToolsetBinding | null
  bindings(): ClientToolsetBinding[]
  /** Bind a name to a client, or refresh its title. Throws when the name is another client's. */
  bind(toolset: string, clientId: string, title: string): ClientToolsetBinding
  setGranted(toolset: string, conversation: ConversationRef, granted: boolean): void
  /** The toolsets one conversation was opened to. */
  grantsOf(conversation: ConversationRef): string[]
  /** Forget everything a client held. Answers the toolset names that were its. */
  forgetClient(clientId: string): string[]
}

const same = (a: ConversationRef, b: ConversationRef) => a.workspaceId === b.workspaceId && a.agentId === b.agentId

/** One binding as a row (or the file before the database) holds it, held to what this store keeps; null for anything else. */
function readBinding(entry: unknown): ClientToolsetBinding | null {
  const value = entry as Record<string, unknown> | null
  if (
    typeof value?.toolset !== 'string' ||
    !STUDIO_TOOLSET_NAME_PATTERN.test(value.toolset) ||
    typeof value.clientId !== 'string' ||
    !value.clientId
  )
    return null
  const conversations = Array.isArray(value.conversations)
    ? (value.conversations as Array<Record<string, unknown>>)
        .filter((ref) => typeof ref?.workspaceId === 'string' && typeof ref.agentId === 'string')
        .map((ref) => ({ workspaceId: ref.workspaceId as string, agentId: ref.agentId as string }))
        .slice(0, MAX_GRANTS_PER_TOOLSET)
    : []
  return {
    toolset: value.toolset,
    clientId: value.clientId,
    title: typeof value.title === 'string' ? value.title.slice(0, 60) : value.toolset,
    boundAt: typeof value.boundAt === 'string' ? value.boundAt : new Date(0).toISOString(),
    conversations,
  }
}

/** The bindings the file builds before the database wrote holds (the import); null for one that is not that. */
export function readClientToolsetsFile(raw: string): ClientToolsetBinding[] | null {
  try {
    const parsed = JSON.parse(raw) as { bindings?: unknown }
    if (!Array.isArray(parsed.bindings)) return null
    return parsed.bindings.flatMap((entry) => {
      const binding = readBinding(entry)
      return binding ? [binding] : []
    })
  } catch {
    return null
  }
}

export function createClientToolsetStore(options: {
  /** The data folder's database; absent, the bindings live in memory only (tests, a Studio with no disk of its own). */
  database?: StudioDatabase
  now?: () => Date
  log?: (message: string) => void
}): ClientToolsetStore {
  const now = options.now ?? (() => new Date())
  const table = options.database ? createRecordTable(options.database, 'client_toolsets', options.log) : null
  const bindings = new Map<string, ClientToolsetBinding>()
  for (const row of table?.loadNow() ?? []) {
    let binding: ClientToolsetBinding | null = null
    try {
      binding = readBinding(JSON.parse(row.body))
    } catch {
      binding = null
    }
    // Unreadable: not bound, so the first app to offer the name takes it.
    // That loses no authority an app had (a binding only ever refuses).
    if (binding) bindings.set(binding.toolset, binding)
    else options.log?.(`The client toolset binding ${row.id} does not read; the name is free again.`)
  }

  function persist(): void {
    void table?.save([...bindings.values()].map((binding) => ({ id: binding.toolset, body: JSON.stringify(binding) })))
  }

  const copy = (binding: ClientToolsetBinding): ClientToolsetBinding => ({
    ...binding,
    conversations: binding.conversations.map((ref) => ({ ...ref })),
  })

  return {
    binding: (toolset) => {
      const found = bindings.get(toolset)
      return found ? copy(found) : null
    },
    bindings: () => [...bindings.values()].map(copy),
    bind(toolset, clientId, title) {
      const existing = bindings.get(toolset)
      if (existing && existing.clientId !== clientId) throw new Error(`"${toolset}" is bound to another client.`)
      if (existing) {
        if (existing.title !== title) {
          existing.title = title
          persist()
        }
        return copy(existing)
      }
      if (bindings.size >= MAX_BINDINGS) throw new Error(`${MAX_BINDINGS} toolset names are bound already.`)
      const created: ClientToolsetBinding = {
        toolset,
        clientId,
        title,
        boundAt: now().toISOString(),
        conversations: [],
      }
      bindings.set(toolset, created)
      try {
        persist()
      } catch (error) {
        bindings.delete(toolset)
        throw error
      }
      return copy(created)
    },
    setGranted(toolset, conversation, granted) {
      const binding = bindings.get(toolset)
      if (!binding) throw new Error(`"${toolset}" is not bound to any client.`)
      const held = binding.conversations.some((ref) => same(ref, conversation))
      if (held === granted) return
      const before = binding.conversations
      binding.conversations = granted
        ? [...before, { workspaceId: conversation.workspaceId, agentId: conversation.agentId }].slice(
            -MAX_GRANTS_PER_TOOLSET,
          )
        : before.filter((ref) => !same(ref, conversation))
      try {
        persist()
      } catch (error) {
        binding.conversations = before
        throw error
      }
    },
    grantsOf: (conversation) =>
      [...bindings.values()]
        .filter((binding) => binding.conversations.some((ref) => same(ref, conversation)))
        .map((binding) => binding.toolset),
    forgetClient(clientId) {
      const names = [...bindings.values()].filter((binding) => binding.clientId === clientId).map((b) => b.toolset)
      if (!names.length) return []
      for (const name of names) bindings.delete(name)
      persist()
      return names
    },
  }
}
