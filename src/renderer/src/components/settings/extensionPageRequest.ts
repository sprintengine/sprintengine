// An extension page another part of the window asked Settings → Extensions to
// open: an install link main handed this window. Kept here until the page is
// drawn, which takes it. Opening a page never installs anything.

export type ExtensionPageRequest = { catalogue: string; id: string }

let pending: ExtensionPageRequest | null = null
const listeners = new Set<() => void>()

export function requestExtensionPage(request: ExtensionPageRequest): void {
  pending = request
  for (const listener of listeners) listener()
}

/** The page asked for, once: taking it clears it. */
export function takeExtensionPageRequest(): ExtensionPageRequest | null {
  const request = pending
  pending = null
  return request
}

export function onExtensionPageRequest(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
