// `install`, `update` and `open`: a published extension, through the Studio
// running on this machine (its gateway's local socket, cli-studio.ts), by the
// path Settings takes. Nothing here approves: an install that runs code waits
// for the person, whose Studio window asks them, and the command exits 3
// (`approval_required`) saying so; an update that asks for more is held for
// their review there, and the version installed keeps running.

import { isAbsolute, resolve } from 'node:path'

import { CliError, type Output } from './cli-output.js'
import { connectStudio, type StudioTools } from './cli-studio.js'
import { readExtensionInstallSource } from './install-source.js'

type Approval = { state: string; fingerprint?: string; growth?: string[] }
type UpdateRow = {
  key: string
  from: string
  to?: string
  status: 'updated' | 'up_to_date' | 'held' | 'refused'
  reason?: string
  code?: string
  growth?: string[]
  /** How long a `held_back` release still waits, in milliseconds. */
  heldBackMs?: number
}

async function withStudio<T>(dataDir: string | undefined, work: (studio: StudioTools) => Promise<T>): Promise<T> {
  const studio = await connectStudio(dataDir ? { dataDir } : {})
  try {
    return await work(studio)
  } finally {
    studio.close()
  }
}

const WAITING_WORDS = 'waiting for approval in Studio'

export async function installExtension(output: Output, source: string, options: { dataDir?: string }) {
  // Read here first, so a source that is none of the forms never reaches Studio.
  const read = readExtensionInstallSource(source)
  if (!read.ok) throw new CliError('invalid_argument', read.message)
  // A fetch and a check-out can take a while.
  const answer = await withStudio(options.dataDir, (studio) =>
    studio.call('extension.install', { source }, 180_000),
  ).catch((error: unknown) => {
    // Installing over an installed extension is an update, or the person's to do.
    if (error instanceof CliError && error.code === 'already_installed') {
      const key = read.source.kind === 'catalogue' ? read.source.key : '<key>'
      throw new CliError(error.code, error.message, error.data, [
        `sprintengine-extension update ${key} installs the newer release its catalogue lists.`,
        `To install it again from another source, the person removes it in Studio's Settings > Extensions first.`,
      ])
    }
    throw error
  })
  const moduleId = String(answer.moduleId)
  const approval = answer.approval as Approval
  if (approval.state === 'pending')
    throw new CliError(
      'approval_required',
      `${moduleId} is installed, ${WAITING_WORDS}: nothing in it runs until the person approves it there.`,
      { moduleId, ...(approval.growth?.length ? { growth: approval.growth } : {}) },
      [
        `Studio's window asks the person to approve it now (also Settings > Extensions).`,
        `sprintengine-extension list shows it once it is approved.`,
      ],
    )
  output.done(answer, [
    `Installed ${moduleId}${answer.catalogue ? ` from the ${String(answer.catalogue)} catalogue` : ''} (${approval.state}).`,
    ...((answer.leftOut as string[] | undefined) ?? []).map((part) => `left out: ${part}`),
  ])
}

function rowWords(row: UpdateRow): string {
  switch (row.status) {
    case 'updated':
      return `${row.key}  ${row.from} → ${row.to ?? '?'}`
    case 'up_to_date':
      return `${row.key}  ${row.from} (up to date)`
    case 'held':
      return `${row.key}  ${row.from}, ${row.to ?? '?'} held: ${row.reason ?? ''}${row.growth?.length ? ` It asks for: ${row.growth.join(', ')}.` : ''}`
    default:
      return `${row.key}  ${row.from || '-'} not updated: ${row.reason ?? ''}`
  }
}

/**
 * `update <key>`, or `update --all`. `--json` prints one row per extension:
 * from and to, or why it did not update. A single extension that was not
 * updated fails with its row's code (an update held for approval exits 3).
 * With `--all`, every row is printed first; then it fails `approval_required`
 * (exit 3) when any is held for approval, else `update_failed` (exit 1) when
 * any was held or refused, `data.updates` holding every row.
 */
export async function updateExtensions(output: Output, key: string | undefined, options: { dataDir?: string }) {
  const answer = await withStudio(options.dataDir, (studio) =>
    studio.call('extension.update', key ? { moduleId: key } : { all: true }, 300_000),
  )
  const rows = (answer.updates ?? []) as UpdateRow[]
  const [only] = rows
  if (key && only && (only.status === 'held' || only.status === 'refused'))
    throw new CliError(only.code ?? 'install_failed', rowWords(only), { updates: rows })
  const notUpdated = rows.filter((row) => row.status === 'held' || row.status === 'refused')
  if (notUpdated.length > 0) {
    const waiting = notUpdated.some((row) => row.status === 'held' && row.code === 'approval_required')
    const lines = rows.map(rowWords)
    throw new CliError(
      waiting ? 'approval_required' : 'update_failed',
      `${notUpdated.length} of ${rows.length} not updated:\n${notUpdated.map(rowWords).join('\n')}`,
      { updates: rows },
      waiting
        ? [`Studio's window asks the person to review what is held (also Settings > Extensions).`]
        : lines.length > notUpdated.length
          ? ['The others were updated; each row says why one was not.']
          : [],
    )
  }
  output.done({ updates: rows }, rows.length === 0 ? 'Nothing installed from a catalogue.' : rows.map(rowWords))
}

export async function openExtension(
  output: Output,
  key: string,
  options: { panel?: string; editor?: string; dataDir?: string },
) {
  if (options.panel && options.editor) throw new CliError('invalid_argument', 'Name --panel or --editor, not both.')
  const editor = options.editor ? resolve(options.editor) : undefined
  if (editor !== undefined && !isAbsolute(editor)) throw new CliError('invalid_argument', '--editor is a file.')
  const answer = await withStudio(options.dataDir, (studio) =>
    studio.call('extension.open', {
      moduleId: key,
      ...(options.panel ? { panel: options.panel } : {}),
      ...(editor ? { editor } : {}),
    }),
  )
  output.done(
    answer,
    answer.panel
      ? `Showing ${key}'s panel ${String(answer.panel)} in Studio's window.`
      : `Opened ${String(answer.file)} in ${key}'s editor in Studio's window.`,
  )
}
