import { toolError, type McpToolRegistration, type McpToolResult } from '../../shared/modules/mcp-tools'
import { launchingAgentOf } from '../../main/agent-launch-notices'
import {
  FILE_VIEW_MAX_FILES,
  FILE_VIEW_MAX_HIGHLIGHTS,
  FILE_VIEW_MAX_NOTE_CHARS,
  type FileViewRequest,
  type FileViews,
} from './file-views'

// `file.view`: an agent shows the person files in its chat, as a small
// editor of each, in tabs (server/file-views/file-views.ts). The person reads
// and edits them there, and their edits are saved as they type. The call only
// opens the view: nothing the agent passes is ever written, and the agent
// learns nothing of what the person types until it reads the file again.

export const FILE_VIEW_TOOL = 'file.view'

export type FileViewToolsDeps = { views: Pick<FileViews, 'show'> }

function json(structured: Record<string, unknown>): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured }
}

/** The files a call names, read leniently: a path is text; anything else is dropped or refused. */
function requestsOf(value: unknown): FileViewRequest[] | string {
  if (!Array.isArray(value) || value.length === 0) return '"files" lists the files to show, each { path }.'
  if (value.length > FILE_VIEW_MAX_FILES) return `Show at most ${FILE_VIEW_MAX_FILES} files in one call.`
  const files: FileViewRequest[] = []
  for (const item of value) {
    const entry = typeof item === 'string' ? { path: item } : item
    if (!entry || typeof entry !== 'object' || typeof (entry as { path?: unknown }).path !== 'string')
      return 'Each file is { path, highlights? }.'
    const { path, highlights } = entry as { path: string; highlights?: unknown }
    if (!path.trim()) return 'Each file names its path.'
    files.push({
      path,
      ...(Array.isArray(highlights) ? { highlights: highlights as FileViewRequest['highlights'] } : {}),
    })
  }
  return files
}

export function createFileViewTools(deps: FileViewToolsDeps): McpToolRegistration[] {
  return [
    {
      name: FILE_VIEW_TOOL,
      description:
        'Show the person files in this chat, as a small editor of each in tabs (one tab per file), with the ' +
        'file\'s path at the top. Use it when they ask to see a file ("show me my CLAUDE.md") or to point at ' +
        'code: instead of pasting the file into your reply, which they cannot edit. They can edit each file in ' +
        'place; their edits are saved to the file as they type, and a file changed on disk meanwhile is not ' +
        'overwritten. You never write through this tool, and you do not see their edits unless you read the ' +
        'file again. A path is absolute, `~/`-relative, or relative to your working folder; it may be outside ' +
        'the project (a file in their home folder). Each file may carry line ranges to look at, `highlights: ' +
        '[{ from, to, note? }]` (1-based, inclusive), which are marked, with the short note beside the first ' +
        'line, and the view opens scrolled to the first one. Text files up to 2 MB. Answers each file as ' +
        'shown, by its real path, and any it could not show, with why.',
      inputSchema: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            minItems: 1,
            maxItems: FILE_VIEW_MAX_FILES,
            description: 'The files, in tab order.',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'The file to show.' },
                highlights: {
                  type: 'array',
                  maxItems: FILE_VIEW_MAX_HIGHLIGHTS,
                  description: 'Line ranges for the person to look at.',
                  items: {
                    type: 'object',
                    properties: {
                      from: { type: 'integer', minimum: 1, description: 'First line, 1-based.' },
                      to: { type: 'integer', minimum: 1, description: 'Last line, inclusive; `from` when omitted.' },
                      note: {
                        type: 'string',
                        maxLength: FILE_VIEW_MAX_NOTE_CHARS,
                        description: 'A few words on what to look at here.',
                      },
                    },
                    required: ['from'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['path'],
              additionalProperties: false,
            },
          },
        },
        required: ['files'],
        additionalProperties: false,
      },
      mutates: false,
      handler: async (args, context) => {
        const chat = launchingAgentOf(context)
        if (!chat)
          return toolError(
            'not_an_agent',
            'file.view draws in the calling agent’s chat, and this call came from no agent of this app.',
          )
        const files = requestsOf(args.files)
        if (typeof files === 'string') return toolError('invalid_arguments', files)
        const { shown, failed } = await deps.views.show(chat, files)
        if (shown.length === 0)
          return toolError(
            'not_shown',
            `No file could be shown. ${failed.map((entry) => `${entry.path}: ${entry.reason}`).join(' ')}`,
          )
        return json({
          ok: true,
          files: shown,
          ...(failed.length > 0 ? { notShown: failed } : {}),
          shown:
            'The files are open in the chat, in tabs, for the person to read and edit. Their edits save to the files.',
        })
      },
    },
  ]
}
