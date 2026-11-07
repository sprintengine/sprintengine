import { randomUUID } from 'node:crypto'
import * as nodePath from 'node:path'

import { CANVAS_FILE_EXTENSION } from '../../shared/canvas/paths'
import { canvasFail, canvasOk, type CanvasExportImages, type CanvasResult } from '../../shared/canvas/types'
import { errorMessage } from '../../shared/errors'
import type { CanvasFs } from './canvas-service'

// Writing an export: a board's file and the pictures the tab rendered of it,
// into a folder the person picked on this machine. Shared by the canvas
// service, for a board here, and by a paired chat's pane, for a board on the
// machine the chat runs on, whose scene this desktop holds a copy of.

/** An exported picture past these is not something the tab rendered from a board. */
const EXPORT_MAX_PNG_BASE64 = 64 * 1024 * 1024
const EXPORT_MAX_SVG_CHARS = 64 * 1024 * 1024

/** The images an export carries, judged before anything is written. */
export function checkCanvasExport(directory: string, images: CanvasExportImages): CanvasResult<void> {
  if (typeof directory !== 'string' || !nodePath.isAbsolute(directory)) {
    return canvasFail('invalid_path', 'An export needs an absolute folder to write into.')
  }
  if (images.png !== undefined && (typeof images.png !== 'string' || images.png.length > EXPORT_MAX_PNG_BASE64)) {
    return canvasFail('too_large', 'The PNG image is not one this board could have produced.')
  }
  if (
    images.svg !== undefined &&
    (typeof images.svg !== 'string' || images.svg.length > EXPORT_MAX_SVG_CHARS || !/<svg[\s>]/i.test(images.svg))
  ) {
    return canvasFail('invalid_scene', 'The SVG image is not an SVG document.')
  }
  return canvasOk(undefined)
}

/**
 * Each file through a temp and a rename, like the board itself: a re-export
 * over a copy already committed must never leave a half-written file in the
 * person's repository. An existing file of the same name is replaced.
 * `isBoardItself` names a file that already is this board (a legacy board
 * exported into its own folder), which is left alone rather than rewritten.
 */
export async function writeCanvasExport(
  fs: CanvasFs,
  input: {
    directory: string
    name: string
    text: string
    images: CanvasExportImages
    isBoardItself?: (file: string) => boolean
  },
): Promise<CanvasResult<{ directory: string; files: string[] }>> {
  const { directory, name, images } = input
  const outputs: Array<{ file: string; contents: string | Uint8Array }> = [
    { file: nodePath.join(directory, `${name}${CANVAS_FILE_EXTENSION}`), contents: input.text },
  ]
  if (images.png) {
    outputs.push({ file: nodePath.join(directory, `${name}.png`), contents: Buffer.from(images.png, 'base64') })
  }
  if (images.svg) outputs.push({ file: nodePath.join(directory, `${name}.svg`), contents: images.svg })
  try {
    await fs.mkdir(directory)
  } catch (error) {
    return canvasFail('forbidden', `The folder ${directory} could not be created: ${errorMessage(error)}`)
  }
  const written: string[] = []
  for (const output of outputs) {
    if (input.isBoardItself?.(output.file)) {
      written.push(output.file)
      continue
    }
    const temp = `${output.file}.${randomUUID()}.tmp`
    try {
      if (typeof output.contents === 'string') await fs.writeFile(temp, output.contents)
      else if (fs.writeBytes) await fs.writeBytes(temp, output.contents)
      else throw new Error('this filesystem cannot write binary files')
      await fs.rename(temp, output.file)
    } catch (error) {
      await fs.unlink(temp).catch(() => {})
      return canvasFail('forbidden', `${output.file} could not be written: ${errorMessage(error)}`)
    }
    written.push(output.file)
  }
  return canvasOk({ directory, files: written })
}
