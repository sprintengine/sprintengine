import { useEffect, useSyncExternalStore } from 'react'
import { ensureProjectLogo, getProjectLogoDataUrl, subscribeProjectLogos } from '../utils/projectLogos'
import { filesApi } from '../studio/files'

/**
 * The project's own logo for an icon slot, or null when the repo has
 * none — which is every caller's cue to keep rendering the workspace-type
 * glyph. Detection runs once per folder per session and is shared across every
 * surface that asks.
 */
export function useProjectLogo(folderPath: string | null | undefined): string | null {
  useEffect(() => {
    ensureProjectLogo(folderPath, (path) => filesApi.detectProjectLogo(path))
  }, [folderPath])

  return useSyncExternalStore(
    subscribeProjectLogos,
    () => getProjectLogoDataUrl(folderPath),
    () => null,
  )
}
