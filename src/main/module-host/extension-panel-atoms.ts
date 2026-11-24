// A components panel's persisted atoms (`atom(key, initial, { persist })`),
// kept in the extension's own data folder: one file for the extension's
// (`plugin`), one per workspace. No permission is needed: it is the panel's
// own state, and it goes when the extension is uninstalled, with the folder.
//
// Each file maps an atom's key to `{ version, value }`. The runtime turns an
// older version into the new shape (`migrate`) when it reads it.

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type StoredAtoms = Record<string, { version: number; value: unknown }>

/** The most atoms one scope keeps, and the most bytes its file may hold. */
export const PANEL_ATOMS_MAX_KEYS = 512
export const PANEL_ATOMS_MAX_BYTES = 1024 * 1024
const ATOM_KEY = /^[A-Za-z0-9_.:-]{1,128}$/u
const FOLDER = 'panel-atoms'

export class PanelAtomsRefusal extends Error {
  readonly code = 'invalid_params'
}

function scopeFile(dataDir: string, scope: 'plugin' | 'workspace', workspaceId?: string): string {
  if (scope === 'plugin') return join(dataDir, FOLDER, 'plugin.json')
  // The id is the workspace's own; hashed, so any id is a safe file name.
  const name = createHash('sha256').update(workspaceId ?? '', 'utf8').digest('hex').slice(0, 24)
  return join(dataDir, FOLDER, `workspace-${name}.json`)
}

async function readScope(file: string): Promise<StoredAtoms> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: StoredAtoms = {}
    for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const version = (entry as { version?: unknown } | null)?.version
      if (ATOM_KEY.test(key) && typeof version === 'number' && entry && typeof entry === 'object' && 'value' in entry)
        out[key] = { version, value: (entry as { value: unknown }).value }
    }
    return out
  } catch {
    return {}
  }
}

// One write at a time per file, so two quick saves never interleave.
const chains = new Map<string, Promise<unknown>>()
function serialized<T>(file: string, run: () => Promise<T>): Promise<T> {
  const next = (chains.get(file) ?? Promise.resolve()).then(run, run)
  const settled = next.catch(() => undefined)
  chains.set(file, settled)
  void settled.then(() => {
    if (chains.get(file) === settled) chains.delete(file)
  })
  return next
}

function workspaceIdOf(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > 400)
    throw new PanelAtomsRefusal('"workspaceId" is the workspace the panel was opened in.')
  return value
}

/** `atoms.read`: the extension's stored atoms, and the workspace's when the panel was opened in one. */
export async function readPanelAtoms(
  dataDir: string,
  params: Record<string, unknown>,
): Promise<{ plugin: StoredAtoms; workspace: StoredAtoms }> {
  const workspaceId = workspaceIdOf(params.workspaceId)
  const [plugin, workspace] = await Promise.all([
    readScope(scopeFile(dataDir, 'plugin')),
    workspaceId === undefined ? Promise.resolve({}) : readScope(scopeFile(dataDir, 'workspace', workspaceId)),
  ])
  return { plugin, workspace }
}

/** `atoms.write`: store the atoms that changed, each in its scope. */
export async function writePanelAtoms(dataDir: string, params: Record<string, unknown>): Promise<{ ok: true }> {
  const workspaceId = workspaceIdOf(params.workspaceId)
  const entries = params.entries
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > PANEL_ATOMS_MAX_KEYS)
    throw new PanelAtomsRefusal(`"entries" lists 1-${PANEL_ATOMS_MAX_KEYS} atoms that changed.`)
  const byScope = new Map<'plugin' | 'workspace', StoredAtoms>()
  for (const raw of entries) {
    const entry = (raw ?? {}) as Record<string, unknown>
    const { scope, key, version } = entry
    if (scope !== 'plugin' && scope !== 'workspace') throw new PanelAtomsRefusal('An atom’s scope is plugin or workspace.')
    if (scope === 'workspace' && workspaceId === undefined)
      throw new PanelAtomsRefusal('A workspace atom is stored for the workspace its panel was opened in.')
    if (typeof key !== 'string' || !ATOM_KEY.test(key)) throw new PanelAtomsRefusal('An atom key is 1-128 letters, digits or . _ : -')
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1)
      throw new PanelAtomsRefusal('An atom’s version is a whole number from 1.')
    if (!('value' in entry)) throw new PanelAtomsRefusal('An atom carries its value.')
    let changes = byScope.get(scope)
    if (!changes) byScope.set(scope, (changes = {}))
    changes[key] = { version, value: entry.value }
  }
  for (const [scope, changes] of byScope) {
    const file = scopeFile(dataDir, scope, workspaceId)
    await serialized(file, async () => {
      const next = { ...(await readScope(file)), ...changes }
      if (Object.keys(next).length > PANEL_ATOMS_MAX_KEYS)
        throw new PanelAtomsRefusal(`A panel keeps at most ${PANEL_ATOMS_MAX_KEYS} persisted atoms in a scope.`)
      const text = JSON.stringify(next)
      if (Buffer.byteLength(text, 'utf8') > PANEL_ATOMS_MAX_BYTES)
        throw new PanelAtomsRefusal(`A panel’s persisted atoms are at most ${PANEL_ATOMS_MAX_BYTES / 1024} KiB in a scope.`)
      await mkdir(join(dataDir, FOLDER), { recursive: true })
      const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temporary, text, 'utf8')
      await rename(temporary, file)
    })
  }
  return { ok: true }
}
