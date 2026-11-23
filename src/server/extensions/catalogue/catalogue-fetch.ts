import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { fetchGitCommit, runGit, type GitOptions } from '../../../../packages/extension-sdk/src/git-source'
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
 * GET one public JSON file with a size cap and a timeout: no cookies, no
 * identifiers. HTTPS; plain HTTP only to this machine, and `file://` only for
 * a moved base.
 */
export async function fetchCatalogueJson(url: string, maxBytes = MAX_JSON_BYTES): Promise<unknown> {
  const parsed = new URL(url)
  let text: string
  if (parsed.protocol === 'file:') {
    const path = fileURLToPath(parsed)
    if ((await stat(path)).size > maxBytes) throw new Error(`${url} is larger than Studio reads.`)
    text = await readFile(path, 'utf8')
  } else {
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback(parsed.hostname)))
      throw new Error(`${url} is not an https:// address.`)
    const response = await fetch(url, {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}.`)
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`${url} is larger than Studio reads.`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new Error(`${url} is larger than Studio reads.`)
    text = new TextDecoder().decode(bytes)
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new Error(`${url} is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The bytes of one file at a URL (a catalogue image), capped. */
export async function fetchCatalogueBytes(url: string, maxBytes: number): Promise<Buffer> {
  const parsed = new URL(url)
  if (parsed.protocol === 'file:') {
    const path = fileURLToPath(parsed)
    if ((await stat(path)).size > maxBytes) throw new Error('The image is larger than Studio shows.')
    return readFile(path)
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback(parsed.hostname)))
    throw new Error(`${url} is not an https:// address.`)
  const response = await fetch(url, {
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}.`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength > maxBytes) throw new Error('The image is larger than Studio shows.')
  return bytes
}

/** One file of a git repository at its `main` branch: an added catalogue's index, or one of its images. */
export async function readGitCatalogueFile(
  url: string,
  path: string,
  maxBytes: number,
  options: GitOptions,
): Promise<{ commit: string; bytes: Buffer }> {
  const fetched = await fetchGitCommit({ url, ref: 'main', ...options })
  try {
    const listing = (
      await runGit(['ls-tree', '--full-tree', '-l', '-z', fetched.commit, '--', path], {
        ...options,
        cwd: fetched.repository,
      })
    ).toString('utf8')
    const match = /^100(?:644|755) blob ([0-9a-f]{40}) +(\d+)\t/.exec(listing)
    if (!match) throw new Error(`The repository holds no ${path} at its main branch.`)
    if (Number(match[2]) > maxBytes) throw new Error(`${path} is larger than Studio reads.`)
    const bytes = await runGit(['cat-file', 'blob', match[1]!], {
      ...options,
      cwd: fetched.repository,
      maxBytes: maxBytes + 1024,
    })
    return { commit: fetched.commit, bytes }
  } finally {
    await fetched.dispose()
  }
}

/** An added catalogue's index, parsed as JSON. */
export async function fetchGitCatalogue(url: string, options: GitOptions): Promise<unknown> {
  const { bytes } = await readGitCatalogueFile(url, ADDED_CATALOGUE_FILENAME, MAX_JSON_BYTES, options)
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch (error) {
    throw new Error(
      `${ADDED_CATALOGUE_FILENAME} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
