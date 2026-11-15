import React, { useCallback, useEffect, useState } from 'react'

import type { ContainerResult, ContainerSummary, ContainerTokenStatus } from '../../../../shared/containers'
import { showToast } from '../../store/toastStore'
import { ContainerGlyph, InlineNotice, Input, OutlineButton, ProviderRow } from '../ui'
import { SettingCard, SettingsRow, SettingsSectionTitle } from './SettingsAtoms'

// Settings › Machines › Containers (docs/design/container-chats.md): every
// container Studio made for a chat, on every machine it made one on, so none
// is left running unseen. A chat's container is removed with the chat; here
// one can be removed by hand, including one Docker still has that Studio lost
// its record of, and a chat's branch can be pushed from the machine it runs on.

type Api = Pick<
  Window['api'],
  | 'containersList'
  | 'containerRemove'
  | 'containerPush'
  | 'onContainersChanged'
  | 'containerTokenStatus'
  | 'containerTokenSet'
  | 'containerTokenClear'
>

export function useContainers(api: Api | null): { containers: ContainerSummary[] | null; reload: () => Promise<void> } {
  const [containers, setContainers] = useState<ContainerSummary[] | null>(null)
  const reload = useCallback(async () => {
    if (typeof api?.containersList !== 'function') return
    const listed = await api.containersList().catch(() => [])
    setContainers(Array.isArray(listed) ? listed : [])
  }, [api])
  useEffect(() => {
    void reload()
    // A container being made says each step: one read for a burst of them.
    let timer: ReturnType<typeof setTimeout> | null = null
    const off =
      typeof api?.onContainersChanged === 'function'
        ? api.onContainersChanged(() => {
            if (timer) clearTimeout(timer)
            timer = setTimeout(() => void reload(), 400)
          })
        : null
    return () => {
      if (timer) clearTimeout(timer)
      if (typeof off === 'function') off()
    }
  }, [api, reload])
  return { containers, reload }
}

export function ContainersSection({ api }: { api: Api | null }): React.JSX.Element | null {
  const { containers, reload } = useContainers(api)
  const [busy, setBusy] = useState<string | null>(null)
  if (!api || !containers) return null

  const act = async (key: string, run: () => Promise<ContainerResult>, done: string) => {
    setBusy(key)
    try {
      const result = await run()
      showToast(
        result.ok
          ? { tone: 'good', title: done, ...(result.message ? { description: result.message } : {}) }
          : { tone: 'error', title: 'Not done', description: result.message },
      )
    } finally {
      setBusy(null)
      void reload()
    }
  }

  return (
    <section className="space-y-2">
      <SettingsSectionTitle count={containers.length}>Containers</SettingsSectionTitle>
      <p className="text-body leading-5 text-[color:var(--text-muted)]">
        The containers Studio made for chats. Each is kept after its chat settles and removed with the chat. A chat’s
        changes leave only as its branch, pushed from the machine the container runs on.
      </p>
      <ClaudeTokenRow api={api} />
      {containers.length > 0 ? (
        <SettingCard as="ul" ariaLabel="Containers">
          {containers.map((container) => {
            const key = container.id ?? `${container.hostLabel}:${container.name}`
            return (
              <ProviderRow
                key={key}
                as="li"
                surface="card"
                icon={<ContainerGlyph className="size-icon-lg" />}
                name={container.name}
                version={container.hostLabel}
                stateLine={
                  container.id && container.pendingRemoval
                    ? `Its chat was deleted; removing it is waiting. ${container.pendingRemoval}`
                    : container.id
                      ? `${container.status}${container.repo ? ` · branch ${container.repo.branch} from ${container.repo.source}` : ''}`
                      : `${container.status}. Studio has no record of this one: its chat is gone.`
                }
                actions={
                  <>
                    {container.id && container.repo ? (
                      <OutlineButton
                        size="xs"
                        disabled={busy !== null}
                        aria-label={`Push ${container.repo.branch} from ${container.name}`}
                        onClick={() => void act(key, () => api.containerPush(container.id!), 'Branch pushed')}
                      >
                        Push branch
                      </OutlineButton>
                    ) : null}
                    <OutlineButton
                      size="xs"
                      disabled={busy !== null}
                      aria-label={`Remove ${container.name}`}
                      onClick={() =>
                        void act(
                          key,
                          () =>
                            container.id
                              ? api.containerRemove({ id: container.id })
                              : api.containerRemove({
                                  host: container.host,
                                  name: container.name,
                                  context: container.context ?? null,
                                }),
                          'Container removed',
                        )
                      }
                    >
                      Remove
                    </OutlineButton>
                  </>
                }
              />
            )
          })}
        </SettingCard>
      ) : null}
      {containers.some((container) => container.status.startsWith('Not read')) ? (
        <InlineNotice
          tone="warn"
          title="Some machines did not answer."
          hint="Their containers are listed as last saved."
        />
      ) : null}
    </section>
  )
}

/**
 * Claude Code's login for chats in containers: a token the person makes once
 * with `claude setup-token` on this computer, kept sealed here and given to
 * each container made on this computer from then on. Without one, Claude Code
 * signs in inside the container through the sign-in dialog the first time a
 * chat asks. The token is never shown back.
 */
function ClaudeTokenRow({ api }: { api: Api }): React.JSX.Element | null {
  const [status, setStatus] = useState<ContainerTokenStatus | null>(null)
  const [draft, setDraft] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const reload = useCallback(async () => {
    if (typeof api.containerTokenStatus !== 'function') return
    setStatus(await api.containerTokenStatus().catch(() => null))
  }, [api])
  useEffect(() => {
    void reload()
  }, [reload])
  if (!status) return null
  const save = async () => {
    const result = await api.containerTokenSet(draft)
    if (!result.ok) {
      setProblem(result.message)
      return
    }
    setDraft('')
    setProblem(null)
    void reload()
  }
  return (
    <SettingCard>
      <SettingsRow
        label="Claude Code in containers"
        help={
          status.set
            ? `Containers on this computer sign Claude Code in with your token${status.kept === 'session' ? ' (kept until Studio quits: this computer has no keychain to seal it with)' : ''}. Nothing else of yours goes inside. Setting or forgetting it restarts their Studio servers, which stops a turn that is running.`
            : 'Run claude setup-token in a terminal here and paste the token it prints. Without one, Claude Code signs in inside each container the first time a chat asks.'
        }
        htmlFor="container-claude-token"
      >
        {status.set ? (
          <OutlineButton
            size="xs"
            onClick={() => void api.containerTokenClear().then(() => reload())}
            aria-label="Forget Claude Code's token for containers"
          >
            Forget token
          </OutlineButton>
        ) : (
          <span className="inline-flex items-center gap-2">
            <Input
              id="container-claude-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              placeholder="sk-ant-…"
              aria-label="Claude Code token for containers"
              className="w-60 max-w-full font-mono"
            />
            <OutlineButton size="xs" disabled={!draft.trim()} onClick={() => void save()}>
              Save
            </OutlineButton>
          </span>
        )}
      </SettingsRow>
      {problem ? (
        <InlineNotice tone="error" className="mx-4 mb-3">
          {problem}
        </InlineNotice>
      ) : null}
    </SettingCard>
  )
}
