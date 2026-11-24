import { statSync } from 'node:fs'

import type { ExtensionContributionsResult } from '../../shared/modules/manifest'
import { extensionDevEvents, type ExtensionDevEvents } from '../../server/extensions/dev/dev-events'
import type { InstalledModule } from './user-module-registry'
import type { ExtensionInvoker } from '../module-host/extension-invocation'

// What Studio says in an extension's own log (`sprintengine-extension dev
// logs <key>`) about the Studio actions it declares it `replaces`. The window
// decides, when the person fires an action, which extension runs in its
// place; but the window cannot write to an extension's log, so the two
// things an author needs to hear are said here, where the log is kept:
//
// - that another extension, installed first, replaces the same action, so
//   theirs does not run (said once per server run, not on every listing);
// - that a replacing call failed or ran past the window's 2 s, so Studio ran
//   its own action instead.

/** The window's time limit for a replacing call (renderer `REPLACEMENT_TIME_LIMIT_MS`). */
export const REPLACEMENT_TIME_LIMIT_MS = 2000

type InstallRecords = Readonly<Record<string, { installedAt?: unknown }>>

/**
 * When each served extension was installed, for the window to tell which of
 * two replacing one action came first: the install record's time, else the
 * folder's (a folder added by hand has no record). A development folder loads
 * after every installed one, in the order it was registered, so it sorts
 * after them.
 */
export function withInstallOrder(
  result: ExtensionContributionsResult,
  modules: readonly InstalledModule[],
  records: InstallRecords,
  folderTime: (root: string) => number | undefined = folderBirth,
): ExtensionContributionsResult {
  const byKey = new Map(modules.map((module) => [module.key, module]))
  const installedTime = (module: InstalledModule): number | undefined => {
    const recorded = records[module.key]?.installedAt
    return typeof recorded === 'number' && Number.isFinite(recorded) ? recorded : folderTime(module.moduleRoot)
  }
  const latest = Math.max(
    0,
    ...modules.filter((module) => !module.development).map((module) => installedTime(module) ?? 0),
  )
  return {
    ...result,
    extensions: result.extensions.map((entry) => {
      const module = byKey.get(entry.id)
      if (!module) return entry
      const installedAt = module.development ? latest + 1 + module.development.order : installedTime(module)
      return installedAt === undefined ? entry : { ...entry, installedAt }
    }),
  }
}

function folderBirth(root: string): number | undefined {
  try {
    const stat = statSync(root)
    return stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs
  } catch {
    return undefined
  }
}

const said = new Set<string>()

/**
 * Tell each extension whose replacement of an action loses to one installed
 * earlier (ties by key, as the window orders them). Once per server run for
 * each pairing, however often the window asks for the listing.
 */
export function noteReplacementLosers(
  extensions: ExtensionContributionsResult['extensions'],
  events: ExtensionDevEvents = extensionDevEvents,
): void {
  const byAction = new Map<string, Array<{ key: string; command: string; installedAt: number }>>()
  for (const entry of extensions)
    for (const command of entry.extension.contributes.commands ?? []) {
      if (command.replaces === undefined || command.action !== undefined) continue
      const list = byAction.get(command.replaces) ?? []
      list.push({ key: entry.id, command: command.id, installedAt: entry.installedAt ?? Number.POSITIVE_INFINITY })
      byAction.set(command.replaces, list)
    }
  for (const [action, list] of byAction) {
    list.sort((a, b) => a.installedAt - b.installedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const [winner, ...losers] = list
    for (const loser of losers) {
      if (loser.key === winner!.key) continue
      const pairing = `${loser.key}\0${loser.command}\0${action}\0${winner!.key}`
      if (said.has(pairing)) continue
      said.add(pairing)
      events.add({
        key: loser.key,
        kind: 'log',
        source: 'studio',
        level: 'warn',
        message: `"${loser.command}" does not run in place of Studio's "${action}": ${winner!.key}, installed first, replaces it. Yours runs only while that one does not.`,
      })
    }
  }
}

/** The action a call's params say it runs in place of (`where: 'replaces'`), or null. */
function replacedAction(params: unknown): string | null {
  if (typeof params !== 'object' || params === null) return null
  const { where, replaces } = params as { where?: unknown; replaces?: unknown }
  return where === 'replaces' && typeof replaces === 'string' ? replaces : null
}

/** The most a window's replacement-call token may hold. */
const REPLACEMENT_CALL_MAX = 100

/**
 * A replacing call as the extension sees it: the window's token for the call
 * (`replacementCall` in its params) is taken off the params, which are the
 * command context the extension's guide documents, and kept on the invoker,
 * so a `runCommand` made for this call names it back to the window.
 */
export function withReplacementCall<T extends { params: unknown; invoker: ExtensionInvoker }>(request: T): T {
  if (replacedAction(request.params) === null) return request
  const { replacementCall, ...params } = request.params as { replacementCall?: unknown }
  if (replacementCall === undefined) return request
  const token =
    typeof replacementCall === 'string' && replacementCall.length > 0 && replacementCall.length <= REPLACEMENT_CALL_MAX
      ? replacementCall
      : undefined
  return { ...request, params, invoker: { ...request.invoker, ...(token ? { replacementCall: token } : {}) } }
}

/**
 * Run a method call, and when it is a replacing one, say in the extension's
 * log when Studio will have run its own action instead: the call was refused
 * or failed, or it was still running at the window's time limit.
 */
export async function watchReplacementCall<T extends { ok: boolean; message?: string; answer?: unknown }>(
  request: { moduleId: string; method: string; params: unknown },
  call: () => Promise<T>,
  events: ExtensionDevEvents = extensionDevEvents,
): Promise<T> {
  const action = replacedAction(request.params)
  if (action === null) return call()
  // One line per call, as the window runs Studio's own once: a call that
  // ran late and then failed was already said.
  let told = false
  const say = (why: string) => {
    if (told) return
    told = true
    events.add({
      key: request.moduleId,
      kind: 'log',
      source: 'studio',
      level: 'warn',
      message: `Studio ran its own "${action}": "${request.method}" ${why.replace(/[.\s]+$/u, '')}.`,
    })
  }
  const timer = setTimeout(
    () => say(`had not answered within ${REPLACEMENT_TIME_LIMIT_MS / 1000} s`),
    REPLACEMENT_TIME_LIMIT_MS,
  )
  try {
    const outcome = await call()
    const refusal = outcome.ok ? (outcome.answer as { ok?: boolean; message?: string } | undefined) : outcome
    if (refusal?.ok === false) say(`did not run: ${refusal.message ?? 'it refused'}`)
    return outcome
  } catch (error) {
    say(`failed: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}
