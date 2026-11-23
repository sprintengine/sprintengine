// An extension's files at one git commit: fetched without a checkout, and
// written out folder by folder from the commit's own blobs. Studio installs
// from what this writes, and `sprintengine-extension release-entry` hashes
// what it writes, so the content hash a catalogue lists is the one Studio
// computes. Runs system git with arguments only (credential helpers and SSH
// keys work as they do for the person), and never runs a hook: the
// repository it fetches into is made with no template.
//
// What is written:
// - regular files, executable or not, under the extension's folder (`path`);
// - not symbolic links (listed in `strippedLinks`), not submodules, and not
//   what an extension never ships (node_modules, .git, key files: listed in
//   `leftOut`), so the folder is one the install's file walk accepts;
// - a path two filesystems would read as one (by case or Unicode form) is
//   refused, so a commit hashes the same on every machine.

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { isPackExcludedPath, isSafeManifestRelativePath } from './manifest-validate.js'
import { isAllowedGitUrl } from './catalogue.js'
import { isSafeExtensionPath } from './extension-manifest.js'

const GIT_TIMEOUT_MS = 120_000
/** The most files, and bytes, an extension's folder at a commit may hold. */
export const GIT_TREE_MAX_FILES = 4096
export const GIT_TREE_MAX_BYTES = 128 * 1024 * 1024
const SHA1_RE = /^[0-9a-f]{40}$/

export type GitOptions = {
  /** Also fetch from `file://` URLs and local paths: for tests and for a development Studio's fixtures. */
  allowFileUrls?: boolean
}

function gitEnv(options: GitOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // An insteadOf rewrite cannot reach another transport or a git-remote-* helper.
    GIT_ALLOW_PROTOCOL: options.allowFileUrls ? 'https:ssh:file' : 'https:ssh',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  }
}

/** Run git with these arguments; its stdout bytes, or an error naming its first line of stderr. */
export function runGit(
  args: string[],
  options: GitOptions & { cwd: string; input?: string; maxBytes?: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd: options.cwd,
        env: gitEnv(options),
        encoding: 'buffer',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: options.maxBytes ?? 16 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.toString('utf8').trim().split('\n')[0] || error.message
          reject(new Error(`git ${args.find((arg) => !arg.startsWith('-')) ?? ''} failed: ${detail}`))
          return
        }
        resolve(stdout)
      },
    )
    if (options.input !== undefined) child.stdin?.end(options.input)
  })
}

/** Whether git may fetch from this URL here. */
export function isFetchableGitUrl(url: string, options: GitOptions = {}): boolean {
  if (isAllowedGitUrl(url)) return true
  if (!options.allowFileUrls) return false
  return url.startsWith('file://') || url.startsWith('/')
}

export type FetchedCommit = {
  /** A bare repository holding the commit; removed by `dispose`. */
  repository: string
  commit: string
  dispose(): Promise<void>
}

/**
 * Fetch one ref (a branch, a tag or a full commit) of a repository, depth
 * one, into a bare repository of its own. Answers the exact commit it
 * resolved to; a commit asked for by its id must be the one fetched.
 */
export async function fetchGitCommit(input: { url: string; ref: string } & GitOptions): Promise<FetchedCommit> {
  if (!isFetchableGitUrl(input.url, input)) throw new Error('The git URL must use HTTPS or SSH, with no password.')
  const ref = input.ref.trim()
  if (!ref || ref.startsWith('-') || /\s/.test(ref)) throw new Error(`"${input.ref}" is not a branch, tag or commit.`)
  const root = await mkdtemp(join(tmpdir(), 'sprintengine-extension-git-'))
  const repository = join(root, 'repository.git')
  const dispose = () => rm(root, { recursive: true, force: true })
  try {
    await runGit(['init', '--quiet', '--bare', '--template=', repository], { ...input, cwd: root })
    await runGit(['fetch', '--quiet', '--depth', '1', '--no-tags', '--', input.url, ref], {
      ...input,
      cwd: repository,
    })
    const commit = (await runGit(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], { ...input, cwd: repository }))
      .toString('utf8')
      .trim()
    if (!SHA1_RE.test(commit)) throw new Error('Git resolved a commit id Studio cannot use (only SHA-1 repositories).')
    if (SHA1_RE.test(ref) && commit !== ref) throw new Error('Git fetched another commit than the one asked for.')
    return { repository, commit, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}

type TreeBlob = { path: string; object: string; size: number; executable: boolean }

export type MaterializedTree = {
  /** Symbolic links in the folder, left out, relative to it. */
  strippedLinks: string[]
  /** Files an extension never ships (node_modules, .git, key files) and submodules, left out. */
  leftOut: string[]
}

const portableIdentity = (path: string) => path.normalize('NFC').toUpperCase().toLowerCase()

/** Parse `git ls-tree -r -z -l` output into what is written, what is stripped, and what is left out. */
function parseTree(bytes: Buffer): { blobs: TreeBlob[]; links: string[]; leftOut: string[] } {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const blobs: TreeBlob[] = []
  const links: string[] = []
  const leftOut: string[] = []
  const seen = new Set<string>()
  for (const record of text.split('\0')) {
    if (!record) continue
    const match = /^(\d{6}) (blob|commit|tree) ([0-9a-f]{40}) +(-|\d+)\t(.+)$/s.exec(record)
    if (!match) throw new Error('Git listed the tree in a form Studio does not read.')
    const [, mode, type, object, size, path] = match as unknown as [string, string, string, string, string, string]
    if (!isSafeManifestRelativePath(path) || path.split('/').some((segment) => portableIdentity(segment) === '.git'))
      throw new Error(`The commit holds a path an extension cannot have: ${path}`)
    const identity = portableIdentity(path)
    if (seen.has(identity)) throw new Error(`The commit holds two paths a filesystem would read as one: ${path}`)
    seen.add(identity)
    if (mode === '120000') links.push(path)
    else if (type !== 'blob' || isPackExcludedPath(path)) leftOut.push(path)
    else if (mode === '100644' || mode === '100755')
      blobs.push({ path, object, size: Number(size), executable: mode === '100755' })
    else leftOut.push(path)
  }
  return { blobs, links, leftOut }
}

/** Split `git cat-file --batch` output into each object's bytes. */
function parseBatch(bytes: Buffer, expected: readonly TreeBlob[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  let offset = 0
  for (const blob of expected) {
    const newline = bytes.indexOf(0x0a, offset)
    if (newline === -1) throw new Error('Git’s blob output ended early.')
    const header = bytes.subarray(offset, newline).toString('utf8')
    const match = /^([0-9a-f]{40}) blob (\d+)$/.exec(header)
    if (!match || match[1] !== blob.object) throw new Error(`Git could not read ${blob.path}.`)
    const size = Number(match[2])
    out.set(blob.object, bytes.subarray(newline + 1, newline + 1 + size))
    offset = newline + 1 + size + 1
  }
  return out
}

/**
 * Write the files of `path` (the repository's root when absent) at `commit`
 * into `destination`, which must be empty. Throws when the folder is not in
 * the commit, or holds what an extension cannot be.
 */
export async function materializeGitTree(
  input: { repository: string; commit: string; path?: string; destination: string } & GitOptions,
): Promise<MaterializedTree> {
  if (input.path !== undefined && !isSafeExtensionPath(input.path))
    throw new Error(`"${input.path}" is not a folder path inside a repository.`)
  await mkdir(input.destination, { recursive: true })
  if ((await readdir(input.destination)).length > 0)
    throw new Error('The folder to write the extension into is not empty.')
  const treeish = input.path ? `${input.commit}:${input.path}` : `${input.commit}^{tree}`
  const kind = (
    await runGit(['cat-file', '-t', treeish], { ...input, cwd: input.repository }).catch(() => Buffer.from(''))
  )
    .toString('utf8')
    .trim()
  if (kind !== 'tree') throw new Error(`The commit has no folder ${input.path ?? '(the root)'}.`)
  const listing = await runGit(['ls-tree', '--full-tree', '-r', '-z', '-l', treeish], {
    ...input,
    cwd: input.repository,
    maxBytes: GIT_TREE_MAX_FILES * 1200,
  })
  const { blobs, links, leftOut } = parseTree(listing)
  if (blobs.length > GIT_TREE_MAX_FILES)
    throw new Error(`The extension’s folder holds more than ${GIT_TREE_MAX_FILES} files.`)
  const total = blobs.reduce((sum, blob) => sum + blob.size, 0)
  if (total > GIT_TREE_MAX_BYTES)
    throw new Error(`The extension’s folder holds more than ${GIT_TREE_MAX_BYTES / 1024 / 1024} MiB.`)
  if (blobs.length > 0) {
    const unique = [...new Map(blobs.map((blob) => [blob.object, blob])).values()]
    const batch = await runGit(['cat-file', '--batch'], {
      ...input,
      cwd: input.repository,
      input: unique.map((blob) => `${blob.object}\n`).join(''),
      maxBytes: unique.reduce((sum, blob) => sum + blob.size + 128, 1024),
    })
    const contents = parseBatch(batch, unique)
    for (const blob of blobs) {
      const target = join(input.destination, ...blob.path.split('/'))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, contents.get(blob.object)!, { flag: 'wx', mode: blob.executable ? 0o755 : 0o644 })
    }
  }
  return { strippedLinks: links.sort(), leftOut: leftOut.sort() }
}
