import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'

import { quotePromptPath } from '../../shared/prompt-path'
import { attachmentImagesRoot } from '../attachment-image-file'

// The images a scheduled agent's prompt names. The launcher attaches a pasted
// image by writing it to the temp folder and putting its path in the prompt
// (attachment-image-file.ts), which is right for a launch now and wrong for a
// run next week: the system clears its temp folder, and the run's agent is
// told to read a file that is gone. So a prompt's temp images are copied, as
// the schedule is saved, to `<data dir>/scheduled-images/<hash>/<name>`, and
// the prompt names the copies.
//
// A copy is kept while any scheduled agent's prompt names it, and goes once
// none does (`prune`, after every save and removal). One made in the last
// hour is left whichever prompt names it, so a save still being written is
// never raced by another's prune.
//
// A schedule handed over to another machine (design-wsl-ssh-direct) takes
// its kept images with it: `keptImagesIn` names them here, and that
// machine's Studio keeps the bytes under its own data directory
// (`keepScheduledImage`) and names its copies in the prompt instead
// (`respellPromptPath`).

export const SCHEDULED_IMAGES_DIRNAME = 'scheduled-images'
const FRESH_MS = 60 * 60 * 1000
/** How a temp image's folder is named (`writeAttachmentImageFile`'s `mkdtemp`). */
const TEMP_FOLDER = /^image-[A-Za-z0-9]{6}$/u

export type ScheduledPromptImages = {
  /** The prompt with each temp image it names copied and named by its copy. */
  keep(prompt: string): Promise<string>
  /** Remove every copy no prompt names. */
  prune(prompts: readonly string[]): Promise<void>
}

export function createScheduledPromptImages(options: {
  dataDir: string
  tempRoot?: string
  now?: () => number
}): ScheduledPromptImages {
  const root = join(options.dataDir, SCHEDULED_IMAGES_DIRNAME)
  const tempRoot = options.tempRoot ?? attachmentImagesRoot()
  const now = options.now ?? Date.now

  /** Each temp image the prompt names, by the path it names it by. */
  async function tempImagesIn(prompt: string): Promise<string[]> {
    if (!prompt.includes(tempRoot)) return []
    let folders: string[]
    try {
      folders = await readdir(tempRoot)
    } catch {
      return []
    }
    const named: string[] = []
    for (const folder of folders) {
      if (!TEMP_FOLDER.test(folder) || !prompt.includes(`${tempRoot}${sep}${folder}${sep}`)) continue
      const files = await readdir(join(tempRoot, folder)).catch(() => [] as string[])
      for (const file of files) {
        const path = join(tempRoot, folder, file)
        if (prompt.includes(path)) named.push(path)
      }
    }
    return named
  }

  async function copyOf(path: string): Promise<string | null> {
    try {
      const info = await lstat(path)
      if (!info.isFile()) return null
      const bytes = await readFile(path)
      const folder = join(root, imageFolderOf(bytes))
      const name = path.slice(path.lastIndexOf(sep) + 1)
      await mkdir(folder, { recursive: true, mode: 0o700 })
      const kept = join(folder, name)
      await copyFile(path, kept)
      // Fresh again, so a prune racing this save leaves it (see the header).
      const at = new Date(now())
      await utimes(folder, at, at)
      return kept
    } catch {
      return null
    }
  }

  return {
    async keep(prompt) {
      let kept = prompt
      for (const path of await tempImagesIn(prompt)) {
        const copy = await copyOf(path)
        if (!copy) continue
        kept = respellPromptPath(kept, path, copy)
      }
      return kept
    },
    async prune(prompts) {
      let folders: string[]
      try {
        folders = await readdir(root)
      } catch {
        return
      }
      for (const folder of folders) {
        const path = join(root, folder)
        if (prompts.some((prompt) => prompt.includes(`${path}${sep}`))) continue
        try {
          if (now() - (await stat(path)).mtimeMs < FRESH_MS) continue
          await rm(path, { recursive: true, force: true })
        } catch {
          // Gone already, or not ours to read.
        }
      }
    },
  }
}

/** The folder a kept image's bytes go in, under `scheduled-images`. */
function imageFolderOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32)
}

/**
 * The prompt with `from` named as `to`: the quoted spelling first, then any
 * bare one the person typed; `to` is quoted wherever its path needs it.
 */
export function respellPromptPath(prompt: string, from: string, to: string): string {
  return prompt.split(quotePromptPath(from)).join(quotePromptPath(to)).split(from).join(quotePromptPath(to))
}

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** The kept images (`<data dir>/scheduled-images/<hash>/<name>`) a prompt names, each a file. */
export async function keptImagesIn(
  prompt: string,
  dataDir: string,
): Promise<Array<{ path: string; name: string; mediaType: string }>> {
  const root = join(dataDir, SCHEDULED_IMAGES_DIRNAME)
  if (!prompt.includes(`${root}${sep}`)) return []
  const named: Array<{ path: string; name: string; mediaType: string }> = []
  for (const folder of await readdir(root).catch(() => [] as string[])) {
    if (!prompt.includes(`${root}${sep}${folder}${sep}`)) continue
    for (const name of await readdir(join(root, folder)).catch(() => [] as string[])) {
      const path = join(root, folder, name)
      if (!prompt.includes(path)) continue
      if (!(await lstat(path).catch(() => null))?.isFile()) continue
      const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
      named.push({ path, name, mediaType: IMAGE_TYPES[extension] ?? 'application/octet-stream' })
    }
  }
  return named
}

/** Keep an image a handed-over schedule's prompt names, as `keep` keeps a pasted one; answers where. */
export async function keepScheduledImage(dataDir: string, bytes: Buffer, name: string): Promise<string> {
  const safe = name.replace(/[\\/]/gu, '_').replace(/^\.+/u, '_').slice(0, 200) || 'picture'
  const folder = join(dataDir, SCHEDULED_IMAGES_DIRNAME, imageFolderOf(bytes))
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const kept = join(folder, safe)
  const staged = `${kept}.${process.pid}.tmp`
  await writeFile(staged, bytes, { mode: 0o600 })
  await rename(staged, kept)
  return kept
}
