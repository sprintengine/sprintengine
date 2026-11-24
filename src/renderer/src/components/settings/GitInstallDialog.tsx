import React, { useId, useState, type JSX } from 'react'

import { ChipButton, Field, Input } from '../ui'
import { Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../ui/Modal'

// Install → From a git URL: the repository's URL (with `#<branch, tag or
// commit>` to pick one) and, optionally, the folder the extension is in. A
// repository that holds several (a Claude Code plugin marketplace) is
// answered with its plugin folders, offered here to pick from.

export type GitInstallRequest = { git: string; ref?: string; path?: string }

/** The URL field's words as a source: `URL#ref`, and the folder trimmed of slashes. */
export function gitInstallRequest(url: string, folder: string): GitInstallRequest {
  const [git, ref] = url.trim().split('#', 2) as [string, string | undefined]
  const path = folder.trim().replace(/^\/+|\/+$/g, '')
  return { git, ...(ref ? { ref } : {}), ...(path ? { path } : {}) }
}

export function GitInstallDialog({
  initialUrl = '',
  folders = [],
  message,
  onCancel,
  onSubmit,
}: {
  initialUrl?: string
  /** A marketplace's plugin folders, from Studio's last answer. */
  folders?: string[]
  /** Why the last try did not install. */
  message?: string
  onCancel: () => void
  onSubmit: (request: GitInstallRequest) => void
}): JSX.Element {
  const titleId = useId()
  const urlId = useId()
  const folderId = useId()
  const [url, setUrl] = useState(initialUrl)
  const [folder, setFolder] = useState('')
  const canSubmit = url.trim().length > 0
  return (
    <Modal open onClose={onCancel} labelledBy={titleId} size="confirm">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (canSubmit) onSubmit(gitInstallRequest(url, folder))
        }}
      >
        <ModalHeader title="Install from a git URL" titleId={titleId} onClose={onCancel} />
        <ModalBody className="space-y-3">
          <p className="text-body leading-5 text-[color:var(--text-default)]">
            An HTTPS or SSH URL of a repository holding extension.json, or a Claude Code plugin (its skills and MCP
            servers are installed). Add #&lt;branch, tag or commit&gt; to pick one. It is labelled Unverified.
          </p>
          {message ? <p className="text-meta text-[color:var(--tone-error)]">{message}</p> : null}
          <Field label="Git URL" htmlFor={urlId}>
            <Input
              size="md"
              value={url}
              autoFocus
              placeholder="https://github.com/acme/notes.git"
              onChange={(event) => setUrl(event.currentTarget.value)}
            />
          </Field>
          <Field label="Folder" htmlFor={folderId} help="Where the extension is in the repository, if not its root.">
            <Input
              size="md"
              value={folder}
              placeholder="plugins/notes"
              onChange={(event) => setFolder(event.currentTarget.value)}
            />
          </Field>
          {folders.length > 0 ? (
            <div role="group" aria-label="Plugin folders" className="flex flex-wrap gap-1.5">
              {folders.map((candidate) => (
                <ChipButton key={candidate} pressed={folder === candidate} onClick={() => setFolder(candidate)}>
                  {candidate}
                </ChipButton>
              ))}
            </div>
          ) : null}
        </ModalBody>
        <ModalFooter>
          <ModalButton type="button" onClick={onCancel}>
            Cancel
          </ModalButton>
          <ModalButton type="submit" variant="primary" disabled={!canSubmit}>
            Install
          </ModalButton>
        </ModalFooter>
      </form>
    </Modal>
  )
}
