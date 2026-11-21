// Shared sanitation rule for messages produced while resolving, reading or
// drawing extension entries. Anything that may reach a window (launch views,
// contribution states, a frame that failed to draw) must not leak absolute
// filesystem paths; the server (entry-containment.ts) and the window
// (extension-contributions.tsx, ExtensionSurfaceMount.tsx) apply the same rule
// so no process becomes the weak link.

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
