// Shared sanitation rule for messages produced while resolving, serving, or
// evaluating third-party entry bundles. Anything that may reach the renderer
// (launch views, renderer-entry load states) must not leak absolute filesystem
// paths; both the main-side server (entry-containment.ts) and the renderer-side
// loader (third-party-loader.ts) apply the same rule so no process becomes the
// weak link.

export function sanitizeEntryMessage(message: string, fallback: string): string {
  if (containsAbsolutePath(message)) return fallback
  return message
}

// An absolute path wherever it sits in the sentence: a POSIX path after
// anything but a word character, a dot or a separator (`'/x'`, `(/x/a.js:1:2)`,
// `at:/x`); a `file:` URL; a drive path with either separator (`C:\x`, `C:/x`);
// a UNC share (`\\host\share`).
const ABSOLUTE_PATH = /(?:^|[^\w./\\])\/[\w.~-]|file:\/\/|(?:^|[^\w])[A-Za-z]:[\\/]|\\\\[\w.$-]+\\/u

function containsAbsolutePath(message: string): boolean {
  return ABSOLUTE_PATH.test(message)
}
