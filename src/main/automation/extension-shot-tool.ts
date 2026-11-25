import { isAbsolute } from 'node:path'

import { parseComponentTree } from '../../../packages/extension-sdk/src/components/tree'
import { toolError, toolSuccess, type McpToolRegistration } from '../../shared/modules/mcp-tools'

// `visual.extension_shot`: a picture of one of an extension's surfaces as
// Studio draws it, for its author and their agent (`sprintengine-extension
// shot`, `dev watch --shot`). The tool is here, apart from the hidden window
// that draws it (extension-frames/extension-shot.ts), so the tools agents see
// can be listed without Electron.

const DEFAULT_SIZE = { width: 420, height: 640 }

export type ExtensionShotInput = {
  moduleId: string
  point: 'panels' | 'doors' | 'settingsSections'
  id: string
  out: string
  theme: 'light' | 'dark'
  width: number
  height: number
  workspaceId?: string
  settleMs?: number
  /** A components panel's tree as the author's CLI rendered it in a scenario: drawn instead of running the panel. */
  tree?: unknown
  /** The scenario `tree` was rendered in. */
  scenario?: string
}

export type ExtensionShotResult = {
  path: string
  width: number
  height: number
  theme: string
  /** The surface said it was ready and its calls were answered before the capture. */
  settled: boolean
  /** Calls still unanswered at the capture: above 0, the picture may show it loading. */
  pendingRequests: number
  /** What it failed with or logged as errors while it was drawn, at its files and lines. */
  errors: string[]
  /** The scenario drawn, for a shot of one. */
  scenario?: string
}

const SURFACE_POINTS = new Set(['panels', 'doors', 'settingsSections'])

/** `visual.extension_shot`, served by the desktop shell over `shoot` (extension-frames/extension-shot.ts). */
export function createExtensionShotTool(
  shoot: (input: ExtensionShotInput) => Promise<ExtensionShotResult>,
): McpToolRegistration {
  return {
    name: 'visual.extension_shot',
    description:
      'Save a PNG of one of an extension’s surfaces (a panel, a door or a settings section) as Studio draws it: ' +
      'its own frame document, with its host calls answered by Studio now, in a hidden window of this desktop. ' +
      'Waits for the surface to call `studio.ready()` and its calls to be answered. Read the PNG at `path` to see ' +
      'what you built; `errors` lists what it threw or logged, at its files and lines.',
    inputSchema: {
      type: 'object',
      properties: {
        moduleId: { type: 'string', description: 'The extension’s install key, `local.<id>`.' },
        point: { type: 'string', enum: ['panels', 'doors', 'settingsSections'] },
        id: { type: 'string', description: 'The surface’s id in extension.json.' },
        out: { type: 'string', description: 'Where to write the PNG: an absolute path on this machine.' },
        theme: { type: 'string', enum: ['light', 'dark'] },
        width: { type: 'integer', minimum: 200, maximum: 2000 },
        height: { type: 'integer', minimum: 120, maximum: 2000 },
        workspaceId: { type: 'string', description: 'For a panel: the workspace it is opened in.' },
        tree: {
          type: 'object',
          description:
            'For a components panel: a tree it drew in a scenario, rendered by `sprintengine-extension shot --scenario` ' +
            'on this machine. Checked as the window checks one and drawn instead of running the panel.',
        },
        scenario: { type: 'string', maxLength: 200, description: 'The scenario `tree` was drawn in.' },
      },
      required: ['moduleId', 'point', 'id', 'out'],
      additionalProperties: false,
    },
    mutates: true,
    handler: async (args, context) => {
      if (context?.metadata.kind === 'remote-tailnet')
        return toolError(
          'not_permitted',
          'A picture is written to this machine’s disk; a paired device cannot take one.',
        )
      const { moduleId, point, id, out } = args
      if (
        typeof moduleId !== 'string' ||
        typeof id !== 'string' ||
        typeof point !== 'string' ||
        !SURFACE_POINTS.has(point)
      )
        return toolError('invalid_arguments', 'Name the extension, the surface’s point and its id.')
      if (typeof out !== 'string' || !isAbsolute(out) || !out.toLowerCase().endsWith('.png'))
        return toolError('invalid_arguments', '"out" is an absolute path ending in .png.')
      if (args.scenario !== undefined && (typeof args.scenario !== 'string' || args.scenario.length > 200))
        return toolError('invalid_arguments', '"scenario" is the name of the scenario, at most 200 characters.')
      if (args.tree !== undefined) {
        if (point !== 'panels') return toolError('invalid_arguments', '"tree" is drawn for a components panel only.')
        // Checked here, as the window checks a tree a panel posts, before anything draws it.
        const checked = parseComponentTree(args.tree)
        if (!checked.ok) return toolError('invalid_arguments', `"tree" is not one Studio draws: ${checked.error}`)
      } else if (args.scenario !== undefined)
        return toolError('invalid_arguments', '"scenario" names the scenario "tree" was drawn in.')
      const size = (value: unknown, fallback: number, low: number) =>
        typeof value === 'number' && Number.isInteger(value) ? Math.min(2000, Math.max(low, value)) : fallback
      try {
        const result = await shoot({
          moduleId,
          point: point as 'panels' | 'doors' | 'settingsSections',
          id,
          out,
          theme: args.theme === 'light' ? 'light' : 'dark',
          width: size(args.width, DEFAULT_SIZE.width, 200),
          height: size(args.height, DEFAULT_SIZE.height, 120),
          ...(typeof args.workspaceId === 'string' ? { workspaceId: args.workspaceId } : {}),
          ...(args.tree !== undefined ? { tree: args.tree } : {}),
          ...(typeof args.scenario === 'string' ? { scenario: args.scenario } : {}),
        })
        return toolSuccess(result)
      } catch (error) {
        return toolError('shot_failed', error instanceof Error ? error.message : String(error))
      }
    },
  }
}
