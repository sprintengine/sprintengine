// Where this tab's server is, as the page was served from it. Relative to the
// page so a server behind a proxy under a path prefix works unchanged (the
// build uses `base: './'`).

export function webSocketUrl(path: string, query: Record<string, string> = {}): string {
  const url = new URL(path, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.hash = ''
  url.search = ''
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return url.toString()
}

export function webPageUrl(path: string): string {
  return new URL(path, window.location.href).toString()
}

/** The browser was removed in Studio, or its session ran out: back to pairing. */
export function returnToPairing(): void {
  window.location.replace(webPageUrl('./pair'))
}
