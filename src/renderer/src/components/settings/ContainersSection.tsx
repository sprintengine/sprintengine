import React, { useCallback, useEffect, useState } from 'react'

import type { ContainerResult, ContainerSummary } from '../../../../shared/containers'
import { showToast } from '../../store/toastStore'
import { ContainerGlyph, InlineNotice, OutlineButton, ProviderRow, ProviderStateId } from '../ui'
import { SettingCard, SettingsSectionTitle } from './SettingsAtoms'

// Settings › Machines › Containers (docs/design/container-chats.md): every
// container Studio made for a chat, on every machine it made one on, so none
// is left running unseen. A chat's container is removed with the chat; here
// one can be removed by hand, including one Docker still has that Studio lost
// its record of, and a chat's branch can be pushed from the machine it runs on.

type Api = Pick<Window['api'], 'containersList' | 'containerRemove' | 'containerPush' | 'onContainersChanged'>

export function useContainers(api: Api | null): { containers: ContainerSummary[] | null; reload: () => Promise<void> } {
  const [containers, setContainers] = useState<ContainerSummary[] | null>(null)
  const reload = useCallback(async () => {
    if (typeof api?.containersList !== 'function') return
    const listed = await api.containersList().catch(() => [])
    setContainers(Array.isArray(listed) ? listed : [])
  }, [api])
  useEffect(() => {
    void reload()
    const off = typeof api?.onContainersChanged === 'function' ? api.onContainersChanged(() => void reload()) : null
    return typeof off === 'function' ? off : undefined
  }, [api, reload])
  return { containers, reload }
}

export function ContainersSection({ api }: { api: Api | null }): React.JSX.Element | null {
  const { containers, reload } = useContainers(api)
  const [busy, setBusy] = useState<string | null>(null)
  if (!api || !containers || containers.length === 0) return null

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
                container.id
                  ? container.status
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
                            : api.containerRemove({ host: container.host, name: container.name }),
                        'Container removed',
                      )
                    }
                  >
                    Remove
                  </OutlineButton>
                </>
              }
            >
              {container.repo ? (
                <p className="text-meta text-[color:var(--text-muted)]">
                  <ProviderStateId>{container.repo.branch}</ProviderStateId> from {container.repo.source}
                </p>
              ) : null}
            </ProviderRow>
          )
        })}
      </SettingCard>
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
