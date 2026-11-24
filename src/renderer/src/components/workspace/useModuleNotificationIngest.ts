import { useEffect } from 'react'

import { STUDIO_EXTENSION_HOST_CAPABILITY } from '../../../../../packages/studio-protocol/src/public'
import { getRendererHost } from '../../modules'
import { startModuleNotificationIngest } from '../../modules/module-notifications'
import { followWindowStudioPush } from '../../studio/windowStudioPush'
import { useNotificationStore } from '../../store/notificationStore'

/**
 * A capability module's `MainHost.notify`, filed into this window's bell while
 * the window's shell is mounted: the `extension.notifications` stream of the
 * window's Studio, which sends the rows its server still keeps and then each
 * new one. Filed once per delivery id, so a row heard again after a reconnect,
 * or cleared since, is not filed twice. Mounted by the window that draws a
 * bell, which is also what makes `supports('notifications')` true in a renderer.
 */
export function useModuleNotificationIngest(): void {
  useEffect(() => {
    if (typeof window.api?.studioWindowTicket !== 'function') return
    const host = getRendererHost()
    const stop = startModuleNotificationIngest({
      subscribe: (cb) =>
        followWindowStudioPush({
          topic: 'extension.notifications',
          params: {},
          capability: STUDIO_EXTENSION_HOST_CAPABILITY,
          onPayload: cb,
        }),
      file: (deliveryId, entry) => useNotificationStore.getState().fileModuleNotification(deliveryId, entry),
    })
    host.setModuleNotificationsWired(true)
    return () => {
      stop()
      host.setModuleNotificationsWired(false)
    }
  }, [])
}
