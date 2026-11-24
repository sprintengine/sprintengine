// What `sprintengine-extension install <source>` (and the `extension.install`
// tool) may name, read into what Studio installs from: a catalogue's entry by
// its install key, or a git repository at a ref, optionally a folder in it.
//
//   acme.notes                                  a catalogue key: the catalogue that lists it
//   acme/notes  acme/notes@v1.2.0               a GitHub repository, at its default branch or a ref
//   https://host/acme/notes.git#v1.2.0          any git URL, `#ref` naming the ref
//   https://github.com/acme/tools/tree/main/notes   a repository's folder link: ref, then folder
//   https://github.com/acme/notes/releases/tag/v1.2.0   a release's or a tag's page: that tag
//
// `--ref` names the ref apart from the source; `--catalogue` the catalogue a
// key is installed from, when more than one lists it. With no ref Studio
// installs the newest `vX.Y.Z` tag the repository has, else its default
// branch. A branch may hold `/`, so a folder link's ref and folder are split
// by Studio where a branch or tag of the repository ends (`tree`).
//
// Reading the text decides nothing about trust: Studio's install path checks
// the owner, the kill list, the release lock and the approval as ever.

import { parseExtensionInstallKey } from './extension-manifest.js'

export type ExtensionInstallSource =
  | { kind: 'catalogue'; key: string; catalogue?: string }
  | {
      kind: 'git'
      url: string
      ref?: string
      path?: string
      /**
       * A folder link's ref and folder as one (`feature/x/notes`): a branch
       * may hold `/`, so Studio splits it where a branch or tag of the
       * repository ends. `ref` and `path` are the split at the first `/`.
       */
      tree?: string
    }

/** What the command line names apart from the source. */
export type ExtensionInstallOptions = {
  /** The ref, for a repository or a git URL that names none. */
  ref?: string
  /** The catalogue a key is installed from: `official`, `community`, or an added one's URL. */
  catalogue?: string
}

export type ExtensionInstallSourceRead = { ok: true; source: ExtensionInstallSource } | { ok: false; message: string }

const OWNER_REPO = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]+?)(?:\.git)?(?:@([^\s@]+))?$/u
/** A folder link: `/<owner>/<repo>/tree/<ref>[/<path>]`, or with GitLab's `/-/` before `tree`. */
const TREE_PATH = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(?:-\/)?tree\/([^/]+)(?:\/(.+?))?\/?$/u
/** A release's or a tag's page: `/<owner>/<repo>/releases/tag/<tag>`, GitLab's `/-/releases/<tag>` and `/-/tags/<tag>`. */
const TAG_PATH = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(?:releases\/tag|-\/releases|-\/tags)\/(.+?)\/?$/u

const FORMS =
  'Name a catalogue key (acme.notes), a GitHub repository (acme/notes or acme/notes@<ref>), a git URL ' +
  '(with #<ref> for a ref), a link to a folder in a repository (…/tree/<ref>/<folder>), or a release’s or ' +
  'tag’s page (…/releases/tag/<tag>).'

/**
 * The refs a git host keeps that no publisher released: a pull or merge
 * request's, a review's, a note's (git reads a short `pull/42/head` as
 * `refs/pull/42/head`). A host serves a fork's pull request through the
 * parent repository's URL, so one of these would install someone else's code
 * under the repository's owner.
 */
const NOT_RELEASED = /^(?:refs\/(?!heads\/|tags\/)|(?:pull|merge-requests)\/)/u

/**
 * Why `ref` is not one Studio installs from, or null: a ref as git takes it
 * (no spaces, no `..`, nothing that reads as an option), and a branch, a tag
 * or a commit, never a pull request's or another namespace's ref.
 */
export function installRefProblem(ref: string): string | null {
  if (!ref || ref.length > 255 || /\s|\.\.|^-|[~^:?*[\\]/u.test(ref)) return `"${ref}" is not a git ref.`
  if (NOT_RELEASED.test(ref))
    return `"${ref}" is not a branch, a tag or a commit. Studio installs what the repository's owner released, never a pull request's or another namespace's ref.`
  return null
}

/** A folder inside a repository: relative, with no `.` or `..` steps. */
function folderOf(path: string): string | null {
  const parts = decodeURIComponent(path)
    .split('/')
    .filter((part) => part.length > 0)
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) return null
  return parts.join('/')
}

function git(url: string, ref?: string, path?: string, tree?: string): ExtensionInstallSourceRead {
  if (ref !== undefined) {
    const problem = installRefProblem(ref)
    if (problem) return { ok: false, message: problem }
  }
  return {
    ok: true,
    source: {
      kind: 'git',
      url,
      ...(ref !== undefined ? { ref } : {}),
      ...(path !== undefined ? { path } : {}),
      ...(tree !== undefined ? { tree } : {}),
    },
  }
}

/** Read the source as written, before what the command line names apart from it. */
function readSource(value: string): ExtensionInstallSourceRead {
  if (!value) return { ok: false, message: `Name what to install. ${FORMS}` }
  if (!value.includes('/') && !value.includes(':') && !value.includes('#')) {
    return parseExtensionInstallKey(value)
      ? { ok: true, source: { kind: 'catalogue', key: value } }
      : { ok: false, message: `"${value}" is not an install key. ${FORMS}` }
  }
  const short = OWNER_REPO.exec(value)
  if (short && !value.startsWith('/') && !value.startsWith('.')) {
    const [, owner, repo, ref] = short
    return git(`https://github.com/${owner}/${repo}.git`, ref)
  }
  const hash = value.indexOf('#')
  const base = hash >= 0 ? value.slice(0, hash) : value
  const ref = hash >= 0 ? value.slice(hash + 1) : undefined
  if (hash >= 0 && !ref) return { ok: false, message: `"${value}" names no ref after #.` }
  if (/^https:\/\//iu.test(base) && hash < 0) {
    // A URL reads `..` away; a link with one names no folder anyone meant.
    if (/\/\.{1,2}(?:\/|$)/u.test(base)) return { ok: false, message: `"${value}" is not a folder in a repository.` }
    let parsed: URL
    try {
      parsed = new URL(base)
    } catch {
      return { ok: false, message: `"${value}" is not a URL. ${FORMS}` }
    }
    const repository = (owner: string, repo: string) => `${parsed.protocol}//${parsed.host}/${owner}/${repo}.git`
    const tree = TREE_PATH.exec(parsed.pathname)
    if (tree) {
      const [, owner, repo, treeRef, rest] = tree
      const path = rest === undefined ? undefined : folderOf(rest)
      if (rest !== undefined && path === null)
        return { ok: false, message: `"${rest}" is not a folder in a repository.` }
      const first = decodeURIComponent(treeRef!)
      // With a folder, the branch may run on into it: Studio splits them where a ref ends.
      return git(repository(owner!, repo!), first, path ?? undefined, path ? `${first}/${path}` : undefined)
    }
    const tag = TAG_PATH.exec(parsed.pathname)
    if (tag) {
      const [, owner, repo, name] = tag
      return git(repository(owner!, repo!), `refs/tags/${decodeURIComponent(name!)}`)
    }
    if (/\/blob\//u.test(parsed.pathname))
      return {
        ok: false,
        message: `"${value}" links to a file. Link to the folder holding extension.json (…/tree/<ref>/<folder>).`,
      }
  }
  if (/^(https|ssh|file):\/\//iu.test(base) || /^[^\s@/:]+@[^\s:]+:.+$/u.test(base) || base.startsWith('/'))
    return git(base, ref)
  return { ok: false, message: `"${value}" is not something Studio installs from. ${FORMS}` }
}

/**
 * Read an install source; a text that is none of the forms is refused with
 * the forms. `options.ref` names the ref of a source that names none;
 * `options.catalogue` the catalogue of a key.
 */
export function readExtensionInstallSource(
  text: string,
  options: ExtensionInstallOptions = {},
): ExtensionInstallSourceRead {
  const read = readSource(text.trim())
  if (!read.ok) return read
  const { source } = read
  const ref = options.ref?.trim()
  const catalogue = options.catalogue?.trim()
  if (options.catalogue !== undefined && !catalogue) return { ok: false, message: '--catalogue names a catalogue.' }
  if (options.ref !== undefined && !ref) return { ok: false, message: '--ref names a branch, a tag or a commit.' }
  if (source.kind === 'catalogue') {
    if (ref !== undefined)
      return {
        ok: false,
        message: `A catalogue key installs the release its catalogue lists; --ref is for a repository or a git URL.`,
      }
    return catalogue === undefined ? read : { ok: true, source: { ...source, catalogue } }
  }
  if (catalogue !== undefined)
    return { ok: false, message: '--catalogue chooses the catalogue of an install key, not of a repository.' }
  if (ref === undefined) return read
  // A folder link's `--ref` says where its ref ends, and the folder starts.
  if (source.tree !== undefined) {
    if (source.tree !== ref && !source.tree.startsWith(`${ref}/`))
      return { ok: false, message: `"${text.trim()}" does not start with the ref ${ref}.` }
    const problem = installRefProblem(ref)
    if (problem) return { ok: false, message: problem }
    const folder = source.tree.slice(ref.length + 1)
    return { ok: true, source: { kind: 'git', url: source.url, ref, ...(folder ? { path: folder } : {}) } }
  }
  if (source.ref !== undefined && source.ref !== ref)
    return { ok: false, message: `"${text.trim()}" names its ref already (${source.ref}); name it once.` }
  const problem = installRefProblem(ref)
  if (problem) return { ok: false, message: problem }
  return { ok: true, source: { ...source, ref } }
}
