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
  const name = createHash('sha256')
    .update(workspaceId ?? '', 'utf8')
    .digest('hex')
    .slice(0, 24)
  return join(dataDir, FOLDER, `workspace-${name}.json`)
}

type ReadScope = { atoms: StoredAtoms; raw: Record<string, unknown>; malformed: boolean }

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * A scope's file. Missing is empty; one that does not parse as an object is
 * `malformed` (a write moves it aside before it writes). Any other failure
 * to read it throws: what was stored is never taken for nothing.
 */
async function readScope(file: string): Promise<ReadScope> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (isMissing(error)) return { atoms: {}, raw: {}, malformed: false }
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { atoms: {}, raw: {}, malformed: true }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { atoms: {}, raw: {}, malformed: true }
  const raw = parsed as Record<string, unknown>
  const atoms: StoredAtoms = {}
  for (const [key, entry] of Object.entries(raw)) {
    const version = (entry as { version?: unknown } | null)?.version
    if (ATOM_KEY.test(key) && typeof version === 'number' && entry && typeof entry === 'object' && 'value' in entry)
      atoms[key] = { version, value: (entry as { value: unknown }).value }
  }
  return { atoms, raw, malformed: false }
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
    workspaceId === undefined ? null : readScope(scopeFile(dataDir, 'workspace', workspaceId)),
  ])
  return { plugin: plugin.atoms, workspace: workspace?.atoms ?? {} }
}

/**
 * Where `atoms.write` stores: the extension's data folder, made only when a
 * write goes down, and its frame's authority, asked again just before each
 * change, so a write queued behind another, or reading while the extension
 * is uninstalled, makes nothing.
 */
export type PanelAtomsPlace = {
  /** Names the folder for one write at a time per file, without making it. */
  key: string
  dataDir: () => string
  /** Throws when the write is no longer admitted. */
  stillAdmitted?: () => void
}

/** `atoms.write`: store the atoms that changed, each in its scope. */
export async function writePanelAtoms(
  place: string | PanelAtomsPlace,
  params: Record<string, unknown>,
): Promise<{ ok: true }> {
  const where: PanelAtomsPlace = typeof place === 'string' ? { key: place, dataDir: () => place } : place
  const workspaceId = workspaceIdOf(params.workspaceId)
  const entries = params.entries
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > PANEL_ATOMS_MAX_KEYS)
    throw new PanelAtomsRefusal(`"entries" lists 1-${PANEL_ATOMS_MAX_KEYS} atoms that changed.`)
  const byScope = new Map<'plugin' | 'workspace', StoredAtoms>()
  for (const raw of entries) {
    const entry = (raw ?? {}) as Record<string, unknown>
    const { scope, key, version } = entry
    if (scope !== 'plugin' && scope !== 'workspace')
      throw new PanelAtomsRefusal('An atom’s scope is plugin or workspace.')
    if (scope === 'workspace' && workspaceId === undefined)
      throw new PanelAtomsRefusal('A workspace atom is stored for the workspace its panel was opened in.')
    if (typeof key !== 'string' || !ATOM_KEY.test(key))
      throw new PanelAtomsRefusal('An atom key is 1-128 letters, digits or . _ : -')
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1)
      throw new PanelAtomsRefusal('An atom’s version is a whole number from 1.')
    if (!('value' in entry)) throw new PanelAtomsRefusal('An atom carries its value.')
    let changes = byScope.get(scope)
    if (!changes) byScope.set(scope, (changes = {}))
    changes[key] = { version, value: entry.value }
  }
  // Every scope is queued at once, so one call's writes never land between another's.
  await Promise.all(
    [...byScope].map(([scope, changes]) =>
      serialized(scopeFile(where.key, scope, workspaceId), async () => {
        where.stillAdmitted?.()
        const dataDir = where.dataDir()
        const file = scopeFile(dataDir, scope, workspaceId)
        const current = await readScope(file)
        const next = { ...current.raw, ...changes }
        if (Object.keys(next).length > PANEL_ATOMS_MAX_KEYS)
          throw new PanelAtomsRefusal(`A panel keeps at most ${PANEL_ATOMS_MAX_KEYS} persisted atoms in a scope.`)
        const text = JSON.stringify(next)
        if (Buffer.byteLength(text, 'utf8') > PANEL_ATOMS_MAX_BYTES)
          throw new PanelAtomsRefusal(
            `A panel’s persisted atoms are at most ${PANEL_ATOMS_MAX_BYTES / 1024} KiB in a scope.`,
          )
        // The read took its time: the extension may have gone meanwhile.
        where.stillAdmitted?.()
        // The data folder itself is never made here: gone, the write fails.
        await mkdir(join(dataDir, FOLDER)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error
        })
        // What did not parse is kept beside, never written over.
        if (current.malformed) await rename(file, `${file}.malformed-${Date.now()}`)
        const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
        await writeFile(temporary, text, 'utf8')
        await rename(temporary, file)
      }),
    ),
  )
  return { ok: true }
}
