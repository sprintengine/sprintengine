import { useCallback, useEffect, useRef, useState } from 'react'

import type { StudioCatalogueView } from '../../../../../packages/studio-protocol/src/public'
import { extensionCatalogueApi } from '../../studio/extensionCatalogue'
import { windowModuleLifecycle } from '../../studio/moduleLifecycle'

// The catalogues Browse lists: their last copies at once, then read again from
// where they live. Adding and removing one is the owner's, and the page asks
// the person before it adds one.

export function useExtensionCatalogues(active: boolean) {
  const [catalogues, setCatalogues] = useState<StudioCatalogueView[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lifecycle] = useState(() => windowModuleLifecycle())
  const fetchedOnce = useRef(false)

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true)
    try {
      setCatalogues(await extensionCatalogueApi.catalogues(refresh))
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!active || fetchedOnce.current) return
    fetchedOnce.current = true
    void load(false).then(() => load(true))
  }, [active, load])

  const add = useCallback(
    async (url: string): Promise<{ ok: true; id: string } | { ok: false; message: string }> => {
      if (!lifecycle) return { ok: false, message: 'Only this Studio’s owner adds catalogues.' }
      const answer = await lifecycle.addCatalogue(url)
      if (!answer.ok) return answer
      await load(false)
      return { ok: true, id: answer.catalogue.id }
    },
    [lifecycle, load],
  )

  const remove = useCallback(
    async (url: string) => {
      if (!lifecycle) return
      const answer = await lifecycle.removeCatalogue(url)
      if (!answer.ok) setError(answer.message)
      await load(false)
    },
    [lifecycle, load],
  )

  return {
    catalogues,
    loading,
    error,
    refresh: () => void load(true),
    add: lifecycle ? add : null,
    remove: lifecycle ? remove : null,
    reload: () => load(false),
  }
}
