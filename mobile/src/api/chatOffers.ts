import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

import {
  negotiateChatCapabilities,
  studioOffers,
  type ChatCapabilities,
} from '../../../packages/client-runtime/src/public'
import {
  CONVERSATION_IMAGE_DOWNSCALE_CAPABILITY,
  CONVERSATION_MESSAGE_IMAGES_CAPABILITY,
  CONVERSATION_PLANS_CAPABILITY,
  CONVERSATION_STOP_SUBAGENT_CAPABILITY,
  CONVERSATION_SUBAGENTS_CAPABILITY,
} from '../../../packages/conversation-protocol/src/public'
import {
  STUDIO_CONVERSATIONS_CAPABILITY,
  studioGrantAllowsTopic,
  type StudioWelcomeFrame,
} from '../../../packages/studio-protocol/src/public'
import { desktopStudio, desktopWelcome, onDesktopWelcome, studioTargetOf, type DesktopTarget } from './desktopStudio'

// What the phone offers in a desktop's chats, read from what that desktop's
// Studio said in its welcome: its capabilities, its chats' and this pairing's
// grant, read by the method table (`studioGrantAllows`). Every client asks
// the runtime's one function for the chat flags (`negotiateChatCapabilities`);
// the few the phone draws beyond them are read here from the same welcome.
// Nothing is read from what the desktop said at pairing time, and nothing is
// offered before the desktop has said anything.

/** What a desktop's chats may show on this phone. */
export type PhoneChatOffers = ChatCapabilities & {
  /** The desktop's Studio has said what it serves, in this run of the app. */
  said: boolean
  /** The desktop serves its chats and this pairing may follow them. */
  follow: boolean
  /** The picture a step made or looked at is read from the desktop. */
  stepPictures: boolean
  /** The pictures the person sent are read back from the desktop. */
  sentPictures: boolean
  /** A plan the agent proposes is drawn as one, to approve or send back. */
  plans: boolean
  /** One of the chat's agents is stopped by itself. */
  stopAgents: boolean
  /** The desktop names the chat's sub-agents (the chats this one started). */
  subagents: boolean
  /** A picture over 5 MB is shrunk by the desktop: never on the Studio socket, which keeps one as it came. */
  downscale: boolean
  /** Settle, Mark unread, Snooze and visit stamps: the Studio keeps its chats' rest (`chat-lifecycle`) and the grant reaches it. */
  manage: boolean
}

/** The phone's chat flags from a desktop's welcome; everything off before there is one. */
export function phoneChatOffers(
  welcome: Pick<StudioWelcomeFrame, 'capabilities' | 'conversation' | 'grant'> | null,
): PhoneChatOffers {
  const chat = negotiateChatCapabilities(welcome ? { via: 'studio', welcome } : null)
  const serves = (name: string) => welcome?.conversation.capabilities.includes(name) === true
  const follow =
    !!welcome &&
    welcome.capabilities.includes(STUDIO_CONVERSATIONS_CAPABILITY) &&
    studioGrantAllowsTopic(welcome.grant, 'conversation.session')
  return {
    ...chat,
    said: !!welcome,
    follow,
    stepPictures: follow && serves('conversation-images') && studioOffers(welcome!, 'conversation.picture'),
    sentPictures:
      follow && serves(CONVERSATION_MESSAGE_IMAGES_CAPABILITY) && studioOffers(welcome!, 'conversation.picture'),
    plans: serves(CONVERSATION_PLANS_CAPABILITY),
    stopAgents:
      !!welcome && serves(CONVERSATION_STOP_SUBAGENT_CAPABILITY) && studioOffers(welcome, 'conversation.stopSubagent'),
    subagents: follow && serves(CONVERSATION_SUBAGENTS_CAPABILITY),
    downscale: serves(CONVERSATION_IMAGE_DOWNSCALE_CAPABILITY),
    manage: !!welcome && studioOffers(welcome, 'conversation.markUnread'),
  }
}

const NOTHING = phoneChatOffers(null)

/**
 * A desktop's chat flags as its latest welcome says them, kept current: asks
 * the desktop's Studio to connect when nothing has been heard from it in this
 * run of the app, and reads each welcome after that. Everything is off until
 * the first one, and for no desktop at all.
 */
export function useChatOffers(
  target: DesktopTarget | null | undefined,
  /** What the screenshot harness offers in place of a desktop; the app never passes it. */
  override?: PhoneChatOffers | null,
): PhoneChatOffers {
  const baseUrl = target?.baseUrl
  const deviceToken = target?.deviceToken
  const relayedEnvironmentId = target?.relayedEnvironmentId
  const studio = (base: string, token: string): DesktopTarget =>
    studioTargetOf({ baseUrl: base, deviceToken: token, ...(relayedEnvironmentId ? { relayedEnvironmentId } : {}) })
  const welcome = useSyncExternalStore(
    (changed) =>
      baseUrl !== undefined && deviceToken !== undefined
        ? onDesktopWelcome(studio(baseUrl, deviceToken), changed)
        : () => {},
    () => (baseUrl !== undefined && deviceToken !== undefined ? desktopWelcome(studio(baseUrl, deviceToken)) : null),
  )
  useEffect(() => {
    if (baseUrl === undefined || deviceToken === undefined || welcome) return
    // Only to hear its welcome: a desktop that cannot be reached leaves the flags off.
    desktopStudio(studio(baseUrl, deviceToken)).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, deviceToken, relayedEnvironmentId, welcome])
  return override ?? (welcome ? offersOf(welcome) : NOTHING)
}

/**
 * Several desktops' chat flags at once, for the chat list: a reader of each
 * desktop's latest, which changes whenever any of them says something new.
 * Asks no desktop to connect: the list's own read does that.
 */
export function useChatOffersOf(
  targets: readonly DesktopTarget[],
  override?: PhoneChatOffers | null,
): (target: DesktopTarget) => PhoneChatOffers {
  const [heard, setHeard] = useState(0)
  const keys = targets
    .map((target) => `${target.baseUrl}\n${target.deviceToken}\n${target.relayedEnvironmentId ?? ''}`)
    .join('\n\n')
  useEffect(() => {
    const stops = targets.map((target) =>
      onDesktopWelcome(studioTargetOf(target), () => setHeard((count) => count + 1)),
    )
    return () => {
      for (const stop of stops) stop()
    }
    // `keys` names the targets: a new array of the same desktops subscribes nothing again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys])
  return useCallback(
    (target: DesktopTarget) => override ?? chatOffersNow(studioTargetOf(target)),
    // `heard` is what makes a new reader after a welcome.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [override, heard],
  )
}

/** Everything a desktop's chats may do, for the screenshot harness's fake desktop. */
export const ALL_CHAT_OFFERS: PhoneChatOffers = Object.freeze(
  Object.fromEntries(Object.keys(NOTHING).map((name) => [name, name !== 'downscale'])) as PhoneChatOffers,
)

// One object per welcome, so a screen that reads the flags is not drawn again
// for a welcome that said nothing new.
const offered = new WeakMap<StudioWelcomeFrame, PhoneChatOffers>()
function offersOf(welcome: StudioWelcomeFrame): PhoneChatOffers {
  let offers = offered.get(welcome)
  if (!offers) {
    offers = phoneChatOffers(welcome)
    offered.set(welcome, offers)
  }
  return offers
}

/** The latest flags for a desktop without subscribing: what a list read or a stream opened now goes by. */
export function chatOffersNow(target: DesktopTarget): PhoneChatOffers {
  const welcome = desktopWelcome(target)
  return welcome ? offersOf(welcome) : NOTHING
}
