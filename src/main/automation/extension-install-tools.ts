import { isAbsolute } from 'node:path'

import { customEditorMatchRank, fileNameOf } from '../../../packages/extension-sdk/src/custom-editors'
import { readExtensionInstallSource } from '../../../packages/extension-sdk/src/install-source'
import type { ExtensionOpener } from '../../shared/extension-open'
import {
  isRecord,
  toolError,
  toolSuccess,
  type McpConnectionContext,
  type McpToolRegistration,
  type McpToolResult,
} from '../../shared/modules/mcp-tools'
import type { ModuleLifecycle } from '../modules/module-lifecycle'
import type { ExtensionDevBackend } from './extension-dev-tools'

// Installing, updating and opening a published extension from outside the
// window, as tools on the Studio's gateway: what `sprintengine-extension
// install`, `update` and `open` call over the local socket, and what an agent
// with Studio's tools calls itself.
//
//   extension.install  install from a catalogue key, a GitHub repository, a git URL or a folder link
//   extension.update   update one installed extension, or every one, now
//   extension.open     show one of its panels, or open a file in its editor, in a window here
//
// They take the path Settings takes (extension-catalogue.ts): the catalogue
// as it reads now, the release lock, the owner, the kill list. Nothing here
// approves anything. An install that runs code waits for the person, and
// their window asks them at once (`askReview`); an update that asks for more
// is held for their review, as an automatic one is, and the running version
// keeps running. Like the dev loop's tools, they act on this machine, so a
// paired device's call is refused.

export const EXTENSION_INSTALL_TOOL_NAMES = ['extension.install', 'extension.update', 'extension.open'] as const

export type ExtensionInstallToolsDeps = {
  backend: () => Pick<ExtensionDevBackend, 'lifecycle'> | null
  /** A window of this machine shows what `extension.open` names; absent, there is none. */
  openInWindow?: ExtensionOpener
}

function refused(code: string, message: string, data?: Record<string, unknown>): McpToolResult {
  const error = toolError(code, message)
  return data ? { ...error, structuredContent: { ok: false, error: { code, message, data } } } : error
}

function refusedRemote(context: McpConnectionContext | undefined): McpToolResult | null {
  return context?.metadata.kind === 'remote-tailnet'
    ? toolError(
        'not_permitted',
        'Installing and opening extensions acts on the machine Studio runs on; a paired device cannot.',
      )
    : null
}

function lifecycleOf(deps: ExtensionInstallToolsDeps): ModuleLifecycle | McpToolResult {
  return (
    deps.backend()?.lifecycle() ??
    toolError('unavailable', 'This Studio’s extensions have not loaded yet; try again in a moment.')
  )
}

const isResult = (value: unknown): value is McpToolResult =>
  isRecord(value) && Array.isArray((value as { content?: unknown }).content)

function stringArg(args: Record<string, unknown>, key: string, max = 4096): string | null {
  const value = args[key]
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value.trim() : null
}

const NOTHING_APPROVES =
  "Nothing over this connection approves an extension: the person approves it in Studio's window."

export function createExtensionInstallTools(deps: ExtensionInstallToolsDeps): McpToolRegistration[] {
  return [
    {
      name: 'extension.install',
      description:
        'Install a published extension the way Settings ▸ Extensions does: `source` is a catalogue key ' +
        '(`acme.notes`, from the first catalogue that lists it: official, community, then those added), a GitHub ' +
        'repository (`acme/notes`, `acme/notes@v1.2.0`), a git URL (`#<ref>` for a ref), or a link to a folder in ' +
        'a repository (`…/tree/<ref>/<folder>`). Studio checks the owner, the kill list and the release lock first; ' +
        'a private repository is fetched with this machine’s own git credentials. An extension installed already is ' +
        'refused (`already_installed`): update it, or the person removes it in Settings first. A pull request’s ' +
        'ref, or another no publisher released, is refused. A content extension, and one from ' +
        "Studio's official catalogue, is ready at once. Anything else installs waiting for approval " +
        "(`approval.state: pending`): Studio's window asks the person now, and nothing in it runs until they approve " +
        'it there. Nothing here approves it. Poll `extension.list` to see it approved.',
      inputSchema: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: 'A catalogue key, owner/repo[@ref], a git URL[#ref], or a folder link.',
          },
        },
        required: ['source'],
        additionalProperties: false,
      },
      mutates: true,
      handler: async (args, context) => {
        const remote = refusedRemote(context)
        if (remote) return remote
        if (args.approve !== undefined) return toolError('invalid_arguments', NOTHING_APPROVES)
        const text = stringArg(args, 'source')
        if (!text) return toolError('invalid_arguments', '"source" names what to install.')
        const read = readExtensionInstallSource(text)
        if (!read.ok) return toolError('invalid_arguments', read.message)
        const lifecycle = lifecycleOf(deps)
        if (isResult(lifecycle)) return lifecycle
        const { source } = read
        // Nobody is looking at what installs from here: it never replaces an
        // installed extension (`already_installed`), and it reads the kill list fresh.
        const answer =
          source.kind === 'catalogue'
            ? await lifecycle.catalogue.installKey(source.key, { unattended: true })
            : await lifecycle.catalogue.installFrom(
                {
                  git: source.url,
                  ...(source.ref ? { ref: source.ref } : {}),
                  ...(source.path ? { path: source.path } : {}),
                },
                { unattended: true },
              )
        if (!answer.ok)
          return refused(answer.code ?? 'install_failed', answer.message, {
            ...(answer.issues ? { issues: answer.issues } : {}),
            ...(answer.folders ? { folders: answer.folders } : {}),
          })
        // Only the person approves, in their window, which asks them now.
        if (answer.approval.state === 'pending') lifecycle.askReview(answer.moduleId)
        return toolSuccess({
          moduleId: answer.moduleId,
          approval: answer.approval,
          source,
          ...('catalogue' in answer && answer.catalogue ? { catalogue: answer.catalogue } : {}),
          ...('leftOut' in answer && answer.leftOut?.length ? { leftOut: answer.leftOut } : {}),
          ...(answer.strippedLinks.length > 0 ? { strippedLinks: answer.strippedLinks } : {}),
        })
      },
    },
    {
      name: 'extension.update',
      description:
        'Update an installed extension now (`moduleId`), or every one installed from a catalogue (`all: true`), to ' +
        'the newer release its catalogue lists, with the same checks as an install. One row per extension: ' +
        '`updated` (from, to), `up_to_date`, `held` or `refused` with why. A release that asks for more than was ' +
        "approved is held for the person's review in Studio's window, and the version installed keeps running; " +
        'nothing here approves it.',
      inputSchema: {
        type: 'object',
        properties: {
          moduleId: { type: 'string', description: 'The extension’s install key.' },
          all: { type: 'boolean', description: 'Every extension installed from a catalogue.' },
        },
        additionalProperties: false,
      },
      mutates: true,
      handler: async (args, context) => {
        const remote = refusedRemote(context)
        if (remote) return remote
        const moduleId = stringArg(args, 'moduleId', 200)
        if ((moduleId === null) === (args.all !== true))
          return toolError(
            'invalid_arguments',
            'Name one extension ("moduleId"), or ask for all of them ("all": true).',
          )
        const lifecycle = lifecycleOf(deps)
        if (isResult(lifecycle)) return lifecycle
        return toolSuccess({ updates: await lifecycle.catalogue.updateNow(moduleId ?? undefined) })
      },
    },
    {
      name: 'extension.open',
      description:
        "Show one of an installed extension's panels (`panel`, its first when neither is named) in the workspace " +
        "a Studio window of this machine shows, or open a file there in the extension's custom editor (`editor`: an " +
        'absolute path). It never brings the window forward. Refused with `no_window` when no Studio window is ' +
        'open here, and `no_workspace` when none shows a workspace. What it opens answers its calls as the person, ' +
        'in their window, so an agent on a capped preset is refused (`not_permitted`): ask the person to open it.',
      inputSchema: {
        type: 'object',
        properties: {
          moduleId: { type: 'string', description: 'The extension’s install key.' },
          panel: { type: 'string', description: "A panel's id in its extension.json." },
          editor: { type: 'string', description: 'An absolute path to open in its custom editor.' },
        },
        required: ['moduleId'],
        additionalProperties: false,
      },
      mutates: true,
      handler: async (args, context) => {
        const remote = refusedRemote(context)
        if (remote) return remote
        const moduleId = stringArg(args, 'moduleId', 200)
        if (!moduleId) return toolError('invalid_arguments', '"moduleId" is the extension’s install key.')
        const panelId = stringArg(args, 'panel', 200)
        const file = stringArg(args, 'editor')
        if (panelId && file) return toolError('invalid_arguments', 'Name a panel or a file to edit, not both.')
        if (file && !isAbsolute(file))
          return toolError('invalid_arguments', '"editor" is the file, as an absolute path on this machine.')
        const lifecycle = lifecycleOf(deps)
        if (isResult(lifecycle)) return lifecycle
        const view = (await lifecycle.installed()).modules.find((module) => module.manifest.id === moduleId)
        if (!view || view.development?.waiting) return toolError('not_found', `${moduleId} is not installed here.`)
        if (view.killed) return toolError('extension_unavailable', `Studio’s kill list switched ${moduleId} off.`)
        if (view.approval.state === 'pending')
          return toolError('approval_required', `${moduleId} waits for the person to approve it in Studio’s window.`)
        if (lifecycle.list().some((module) => module.id === moduleId && !module.enabled))
          return toolError('extension_unavailable', `${moduleId} is switched off.`)
        const contributes = view.extension.contributes
        let request: Parameters<ExtensionOpener>[0]
        if (file) {
          const name = fileNameOf(file)
          const editor = contributes.customEditors
            .map((candidate) => ({ candidate, rank: customEditorMatchRank(candidate, name) }))
            .filter((entry) => entry.rank > 0)
            .sort((a, b) => b.rank - a.rank)[0]?.candidate
          if (!editor) return toolError('not_found', `${moduleId} has no custom editor for ${name}.`)
          request = { moduleId, file, editor: editor.id, title: editor.title }
        } else {
          const panel = panelId
            ? contributes.panels.find((candidate) => candidate.id === panelId)
            : contributes.panels[0]
          if (!panel)
            return toolError(
              'not_found',
              panelId ? `${moduleId} has no panel "${panelId}".` : `${moduleId} has no panel to show.`,
            )
          request = { moduleId, panel: panel.id, title: panel.title }
        }
        if (!deps.openInWindow) return toolError('no_window', 'No Studio window is open on this machine.')
        const outcome = await deps.openInWindow(request)
        if (!outcome.ok) return toolError(outcome.code, outcome.message)
        return toolSuccess({
          moduleId,
          workspaceId: outcome.workspaceId,
          ...(request.panel ? { panel: request.panel } : { editor: request.editor, file: request.file }),
        })
      },
    },
  ]
}
