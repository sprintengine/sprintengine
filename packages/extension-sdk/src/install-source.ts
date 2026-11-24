// What `sprintengine-extension install <source>` (and the `extension.install`
// tool) may name, read into what Studio installs from: a catalogue's entry by
// its install key, or a git repository at a ref, optionally a folder in it.
//
//   acme.notes                                  a catalogue key: the catalogue that lists it
//   acme/notes  acme/notes@v1.2.0               a GitHub repository, at its default branch or a ref
//   https://host/acme/notes.git#v1.2.0          any git URL, `#ref` naming the ref
//   https://github.com/acme/tools/tree/main/notes   a repository's folder link: ref, then folder
//
// Reading the text decides nothing about trust: Studio's install path checks
// the owner, the kill list, the release lock and the approval as ever.

import { parseExtensionInstallKey } from './extension-manifest.js'

export type ExtensionInstallSource =
  { kind: 'catalogue'; key: string } | { kind: 'git'; url: string; ref?: string; path?: string }

export type ExtensionInstallSourceRead = { ok: true; source: ExtensionInstallSource } | { ok: false; message: string }

const OWNER_REPO = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]+?)(?:\.git)?(?:@([^\s@]+))?$/u
/** A folder link: `/<owner>/<repo>/tree/<ref>[/<path>]`, or with GitLab's `/-/` before `tree`. */
const TREE_PATH = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(?:-\/)?tree\/([^/]+)(?:\/(.+?))?\/?$/u

const FORMS =
  'Name a catalogue key (acme.notes), a GitHub repository (acme/notes or acme/notes@<ref>), a git URL ' +
  '(with #<ref> for a ref), or a link to a folder in a repository (…/tree/<ref>/<folder>).'

/** A ref as git takes it: no spaces, no `..`, nothing that reads as an option. */
function refProblem(ref: string): string | null {
  if (!ref || ref.length > 255 || /\s|\.\.|^-|[~^:?*[\\]/u.test(ref)) return `"${ref}" is not a git ref.`
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

function git(url: string, ref?: string, path?: string): ExtensionInstallSourceRead {
  if (ref !== undefined) {
    const problem = refProblem(ref)
    if (problem) return { ok: false, message: problem }
  }
  return {
    ok: true,
    source: { kind: 'git', url, ...(ref !== undefined ? { ref } : {}), ...(path !== undefined ? { path } : {}) },
  }
}

/** Read an install source; a text that is none of the forms is refused with the forms. */
export function readExtensionInstallSource(text: string): ExtensionInstallSourceRead {
  const value = text.trim()
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
    const tree = TREE_PATH.exec(parsed.pathname)
    if (tree) {
      const [, owner, repo, treeRef, rest] = tree
      const path = rest === undefined ? undefined : folderOf(rest)
      if (rest !== undefined && path === null)
        return { ok: false, message: `"${rest}" is not a folder in a repository.` }
      return git(
        `${parsed.protocol}//${parsed.host}/${owner}/${repo}.git`,
        decodeURIComponent(treeRef!),
        path ?? undefined,
      )
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
