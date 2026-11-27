import { useEffect, useState } from 'react'

import { GhostButton } from '../ui'
import { Banner } from '../ui/Banner'
import { useStudioServerStatus } from './useStudioServerStatus'
import { studioServerNotice } from './studioServerWords'
import { copy } from '../../../../shared/copy'

// The strip across the foot of the workspace card while the Studio server is
// not there: starting (only once it has taken a noticeable moment),
// reconnecting after a crash, or stopped. Everything the shell owns keeps
// working meanwhile (terminals, the git panel, the file explorer); the strip
// says why chats and the panes the server backs are waiting.

/** A server ready within this shows no "starting" strip at all. */
const STARTING_GRACE_MS = 1_500

export function StudioServerBanner() {
  const [status] = useStudioServerStatus()
  const [showStarting, setShowStarting] = useState(false)
  const starting = status?.phase === 'starting'
  useEffect(() => {
    if (!starting) {
      setShowStarting(false)
      return
    }
    const timer = window.setTimeout(() => setShowStarting(true), STARTING_GRACE_MS)
    return () => window.clearTimeout(timer)
  }, [starting])

  const notice = studioServerNotice(status, { showStarting })
  if (!notice) return null
  return (
    <Banner
      tone={notice.tone}
      message={notice.message}
      {...(notice.recoverable ? { onRetry: () => void window.api.studioServerRetry() } : {})}
      // One recovery cluster: Retry, and the server's log, which says what
      // went wrong in more words than the strip has room for.
      action={
        notice.recoverable ? (
          <GhostButton onClick={() => void window.api.studioServerOpenLog()}>
            {copy.studioServer.studioServerBanner.openLog}
          </GhostButton>
        ) : undefined
      }
    />
  )
}
