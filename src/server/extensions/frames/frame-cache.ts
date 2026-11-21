// The frame documents this server built lately, by hash, for its web
// listener to serve at `/ext-frame/<hash>` (frame-route.ts). A document is put
// here when a client asked for it over the Studio protocol (`extension.frame`,
// which checked the extension may be drawn), so the route serves only what was
// built for someone admitted; it serves nothing it was not handed.
//
// One per process: the Studio RPC that builds and the listener that serves run
// in the same one. Bounded by count and bytes, oldest out first.

const MAX_DOCUMENTS = 64
const MAX_BYTES = 64 * 1024 * 1024

export type ExtensionFrameCache = {
  put(hash: string, html: string): void
  get(hash: string): string | undefined
}

export function createExtensionFrameCache(
  limits: { maxDocuments?: number; maxBytes?: number } = {},
): ExtensionFrameCache {
  const maxDocuments = limits.maxDocuments ?? MAX_DOCUMENTS
  const maxBytes = limits.maxBytes ?? MAX_BYTES
  const documents = new Map<string, string>()
  let bytes = 0
  return {
    put(hash, html) {
      const before = documents.get(hash)
      if (before !== undefined) {
        documents.delete(hash)
        documents.set(hash, before)
        return
      }
      documents.set(hash, html)
      bytes += html.length
      for (const [oldest, kept] of documents) {
        if (documents.size <= maxDocuments && bytes <= maxBytes) break
        if (oldest === hash) break
        documents.delete(oldest)
        bytes -= kept.length
      }
    },
    get(hash) {
      return documents.get(hash)
    },
  }
}

/** The process's one cache. */
export const extensionFrameDocuments: ExtensionFrameCache = createExtensionFrameCache()
