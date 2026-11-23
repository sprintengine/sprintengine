import {
  STUDIO_EXTENSION_HOST_CAPABILITY,
  type StudioCatalogueEntryView,
  type StudioCatalogueView,
} from '../../../../packages/studio-protocol/src/public'
import { windowStudioClient } from './windowStudioClient'

// What Settings → Extensions → Browse reads of the window's Studio: its
// catalogues, one extension's page, and a catalogue image's bytes. Reading
// needs `extensions:read`; installing, updating and adding a catalogue are
// the owner's lifecycle commands (moduleLifecycle.ts).

async function client() {
  const connected = await windowStudioClient()
  if (!connected.supports(STUDIO_EXTENSION_HOST_CAPABILITY)) throw new Error('This Studio does not run extensions.')
  return connected
}

export const extensionCatalogueApi = {
  async catalogues(refresh = false): Promise<StudioCatalogueView[]> {
    return (await (await client()).request('extension.catalogues', refresh ? { refresh: true } : {})).catalogues
  },
  async entry(
    catalogue: string,
    id: string,
  ): Promise<{ ok: true; entry: StudioCatalogueEntryView } | { ok: false; message: string }> {
    try {
      return await (await client()).request('extension.catalogueEntry', { catalogue, id })
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  },
  async image(catalogue: string, path: string, sha256: string): Promise<string | null> {
    try {
      const answer = await (await client()).request('extension.catalogueImage', { catalogue, path, sha256 })
      return answer.ok ? `data:${answer.mime};base64,${answer.base64}` : null
    } catch {
      return null
    }
  },
}
