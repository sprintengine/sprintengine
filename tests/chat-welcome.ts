import {
  CONVERSATION_CAPABILITIES,
  STUDIO_CAPABILITIES,
  type StudioGrant,
  type StudioScope,
  type StudioWelcomeFrame,
} from '../packages/studio-protocol/src/public'
import { studioWindowGrant } from '../src/server/rpc/studio-frame-port'

// A Studio's welcome as a chat's tests read it: what a full Studio serves (the
// socket's own withheld conversation capabilities left out, as it leaves them
// out) and a grant. A test builds a transport from one
// (`studioConversationTransport`) rather than naming capabilities itself, so a
// chat part is drawn as the window draws it once its Studio has welcomed it.

export type ChatWelcome = Pick<StudioWelcomeFrame, 'capabilities' | 'conversation' | 'grant' | 'environment'>

/** The grants a chat's controls are tried under. */
export const CHAT_GRANTS = {
  // The window's own grant, as the window listener gives it.
  owner: { owner: true, scopes: studioWindowGrant().scopes },
  'paired operate': {
    owner: false,
    scopes: ['conversation:read', 'conversation:operate', 'files:read'] satisfies StudioScope[],
  },
  'paired read-only': { owner: false, scopes: ['conversation:read'] satisfies StudioScope[] },
  revoked: { owner: false, scopes: [] },
} satisfies Record<string, { owner: boolean; scopes: readonly StudioScope[] }>

export function chatWelcome(
  options: {
    grant?: { owner: boolean; scopes: readonly StudioScope[] }
    /** Capabilities, Studio or conversation, this Studio does not serve. */
    without?: readonly string[]
  } = {},
): ChatWelcome {
  const without = new Set(options.without ?? [])
  const { owner, scopes } = options.grant ?? CHAT_GRANTS.owner
  const grant: StudioGrant = owner
    ? { ...studioWindowGrant(), scopes: [...scopes] }
    : { clientId: 'paired-client', name: 'build-box', owner, scopes: [...scopes], ceiling: 'auto' }
  return {
    environment: { id: 'studio-fixture', hostKind: 'local', os: 'darwin', arch: 'arm64' },
    capabilities: STUDIO_CAPABILITIES.filter((name) => !without.has(name)),
    conversation: {
      protocolVersion: 1,
      minProtocolVersion: 1,
      capabilities: CONVERSATION_CAPABILITIES.filter((name) => !without.has(name)),
    },
    grant,
  }
}
