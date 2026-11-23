import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import {
  fetchGitCommit,
  runGit,
  type FetchedCommit,
  type GitOptions,
} from '../../../../packages/extension-sdk/src/git-source'
import { readStudioEnv } from '../../../shared/studio-env'

// Where Studio reads its catalogues and the lists beside them, and how. The
// official and community catalogues, the owner records, the release lock and
// the kill list are JSON files in Studio's public catalogue repository, read
// over HTTPS. A catalogue the person added is a git repository holding
// `catalogue.json` at its root, read at its `main` branch with system git
// (so a private one reachable over SSH works too).

/** The one place Studio's catalogue addresses live. */
export const EXTENSION_CATALOGUE_BASE = 'https://raw.githubusercontent.com/sprintengine/extensions/main'

export type CatalogueUrls = {
  /** The folder the files are in: catalogue images are relative to it. */
  base: string
  official: string
  community: string
  owners: string
  releaseLock: string
  killList: string
}

/** The file an added catalogue's repository holds at its root. */
export const ADDED_CATALOGUE_FILENAME = 'catalogue.json'

/**
 * Studio's catalogue addresses. `SPRINTENGINE_EXTENSION_CATALOGUE_BASE` moves
 * them to another folder (a `file://` folder or a local server) for a
 * development Studio and end-to-end tests, as `SPRINTENGINE_USER_EXTENSION_ROOT`
 * moves the install folder.
 */
export function extensionCatalogueUrls(base: string = defaultBase()): CatalogueUrls {
  const root = base.replace(/\/+$/, '')
  return {
    base: root,
    official: `${root}/official.json`,
    community: `${root}/community.json`,
    owners: `${root}/owners.json`,
    releaseLock: `${root}/release-lock.json`,
    killList: `${root}/kill-list.json`,
  }
}

function defaultBase(): string {
  return readStudioEnv('SPRINTENGINE_EXTENSION_CATALOGUE_BASE')?.trim() || EXTENSION_CATALOGUE_BASE
}

/**
 * Whether git may read `file://` URLs and local paths: only when the
 * catalogue addresses were moved for a development Studio or a test
 * (`SPRINTENGINE_EXTENSION_GIT_FILE_URLS=1`). A shipped Studio reads HTTPS and SSH only.
 */
export function defaultGitOptions(): GitOptions {
  return readStudioEnv('SPRINTENGINE_EXTENSION_GIT_FILE_URLS') === '1' ? { allowFileUrls: true } : {}
}

const MAX_JSON_BYTES = 16 * 1024 * 1024
const FETCH_TIMEOUT_MS = 30_000

const isLoopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]'

/**
 * GET one public file with a timeout, no cookies and no identifiers, read to
 * at most `maxBytes`: the body is read as it arrives, counted as decoded
 * bytes (a compressed body is held to what it expands to), and the download
 * is cancelled the moment it passes the limit. HTTPS; plain HTTP only to this
 * machine, and `file://` only for a moved base.
 */
async function readBounded(url: string, maxBytes: number, tooLarge: string): Promise<Buffer> {
  const parsed = new URL(url)
  if (parsed.protocol === 'file:') {
    const path = fileURLToPath(parsed)
    if ((await stat(path)).size > maxBytes) throw new Error(tooLarge)
    return readFile(path)
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback(parsed.hostname)))
    throw new Error(`${url} is not an https:// address.`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`${url} took too long to answer.`)), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}.`)
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > maxBytes) {
      controller.abort()
      throw new Error(tooLarge)
    }
    const reader = response.body?.getReader()
    if (!reader) return Buffer.alloc(0)
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        controller.abort()
        throw new Error(tooLarge)
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks, total)
  } finally {
    clearTimeout(timer)
  }
}

/** GET one public JSON file, capped (`readBounded`). */
export async function fetchCatalogueJson(url: string, maxBytes = MAX_JSON_BYTES): Promise<unknown> {
  const text = (await readBounded(url, maxBytes, `${url} is larger than Studio reads.`)).toString('utf8')
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new Error(`${url} is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The bytes of one file at a URL (a catalogue image), capped (`readBounded`). */
export function fetchCatalogueBytes(url: string, maxBytes: number): Promise<Buffer> {
  return readBounded(url, maxBytes, 'The image is larger than Studio shows.')
}

/** One file of a fetched repository at its commit, capped. */
export async function readFetchedFile(
  fetched: Pick<FetchedCommit, 'repository' | 'commit'>,
  path: string,
  maxBytes: number,
  options: GitOptions,
): Promise<Buffer> {
  const listing = (
    await runGit(['ls-tree', '--full-tree', '-l', '-z', fetched.commit, '--', path], {
      ...options,
      cwd: fetched.repository,
    })
  ).toString('utf8')
  const match = /^100(?:644|755) blob ([0-9a-f]{40}) +(\d+)\t/.exec(listing)
  if (!match) throw new Error(`The repository holds no ${path} at its main branch.`)
  if (Number(match[2]) > maxBytes) throw new Error(`${path} is larger than Studio reads.`)
  return runGit(['cat-file', 'blob', match[1]!], {
    ...options,
    cwd: fetched.repository,
    maxBytes: maxBytes + 1024,
  })
}

/**
 * An added catalogue's repository at its `main` branch, and its index parsed
 * as JSON. The repository is kept (until `dispose`), so the catalogue's
 * images are read from the same commit without fetching again.
 */
export async function fetchGitCatalogue(
  url: string,
  options: GitOptions,
): Promise<{ raw: unknown; fetched: FetchedCommit }> {
  const fetched = await fetchGitCommit({ url, ref: 'main', ...options })
  try {
    const bytes = await readFetchedFile(fetched, ADDED_CATALOGUE_FILENAME, MAX_JSON_BYTES, options)
    try {
      return { raw: JSON.parse(bytes.toString('utf8')) as unknown, fetched }
    } catch (error) {
      throw new Error(
        `${ADDED_CATALOGUE_FILENAME} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  } catch (error) {
    await fetched.dispose()
    throw error
  }
}
