import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Chromium keeps compiled shaders and GPU program binaries in the profile and
 * reads them back on the next launch. After an Electron upgrade those entries
 * were written by a different GPU stack, and reading them can leave a window
 * blank or garbled, or take the GPU process down, until they are deleted by
 * hand. So they are cleared once whenever the Electron version changes; Chromium
 * rebuilds them as it draws.
 *
 * Keyed on Electron, not Chromium: an Electron patch release can ship Chromium
 * backports under the same Chrome version.
 */
const GPU_CACHE_DIRECTORIES = [
  'GPUCache',
  'GrShaderCache',
  'ShaderCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GPUPersistentCache',
]

export const GPU_CACHE_MARKER = 'gpu-cache-electron-version'

/**
 * Synchronous on purpose: Chromium opens these caches on the first turn of the
 * event loop, before `ready`, so this has to finish in the entry script. A
 * failure is logged and the launch goes on with the caches as they are.
 */
export function clearStaleGpuCaches(userDataPath: string, electronVersion: string): void {
  const markerPath = join(userDataPath, GPU_CACHE_MARKER)
  try {
    let cachedVersion: string | undefined
    try {
      cachedVersion = readFileSync(markerPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (cachedVersion?.trim() === electronVersion) return
    for (const name of GPU_CACHE_DIRECTORIES) {
      rmSync(join(userDataPath, name), { recursive: true, force: true })
    }
    mkdirSync(userDataPath, { recursive: true })
    writeFileSync(markerPath, electronVersion)
  } catch (error) {
    console.warn('[gpu-cache] could not clear stale GPU caches', {
      electronVersion,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
