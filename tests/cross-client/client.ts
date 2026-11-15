import type { StudioClient } from '../../packages/client-runtime/src/public'
import type { Feed } from './feed'

// One client of the gate: the code a surface of Studio really runs, behind one
// shape, with the transport it uses today named. A cut-over changes how one
// adapter reaches the server (its `transport`, and the code it constructs);
// the scenarios do not change.
//
// A member a client leaves out is something its code cannot do today. The
// scenario still runs for it and fails, which the gate reads against its list
// of known gaps (gaps.ts): never skipped without a word.

export type ClientId = 'desktop' | 'peer' | 'phone' | 'embed' | 'ssh' | 'wsl'

export type ChatRef = { workspaceId: string; agentId: string; workspaceRoot: string }

/** A paired device's own ways onto the desktop it paired with, for asks outside a chat. */
export type DeviceReach = {
  /** Ask the desktop's Studio something on this device's own connection to it. */
  ask<T>(work: (client: StudioClient) => Promise<T>): Promise<T>
  /**
   * A ticket for one socket on the desktop's tailnet listener, bought as this
   * device buys one, naming an environment of that desktop's as the removed
   * relay route did where this device's code can say one. Answers the socket
   * URL it is good for, and the origin the device's sockets say.
   */
  ticket(environmentId: string): Promise<{ url: string; origin: string | null }>
}

export type Attachment = { name: string; mediaType: string; bytes: Buffer; path: string }

export interface GateClient {
  readonly id: ClientId
  /** What it is, in words, and the wire it reaches the server by. */
  readonly label: string
  readonly transport: string
  /** What of this client the gate stands in for, said in the output. */
  readonly simulated: readonly string[]
  /** A paired device's own reach onto the desktop, where it is one. */
  readonly device?: DeviceReach
  /** Follow one chat: everything it hears lands in the feed. */
  follow(chat: ChatRef): Promise<Feed>
  /** Start a chat on the fake provider, the way this client starts one. */
  createChat?(workspace: Omit<ChatRef, 'agentId'>, name: string): Promise<ChatRef>
  send?(chat: ChatRef, text: string): Promise<void>
  sendWithAttachment?(chat: ChatRef, text: string, attachment: Attachment): Promise<void>
  answerApproval?(chat: ChatRef, requestId: string, approve: boolean): Promise<void>
  messageSubagent?(chat: ChatRef, toolUseId: string, text: string): Promise<void>
  scheduleSend?(chat: ChatRef, text: string, sendAt: number): Promise<void>
  sendScheduledNow?(chat: ChatRef, scheduledId: string): Promise<void>
  /** Drop every connection this client holds, and refuse new ones until `heal`. */
  cut(): void
  heal(): void
  /** After `heal`: what the client does on its own to come back, for one that needs a nudge (the phone's foreground). */
  resume?(): void
  close(): Promise<void>
}

export class ClientCannot extends Error {
  constructor(client: string, what: string) {
    super(`${client} has no call to ${what}`)
    this.name = 'ClientCannot'
  }
}

/** The origin a desktop window loaded from the app's files says; its tickets are minted for it. */
export const GATE_WINDOW_ORIGIN = 'file://'

export const MOCK_PROVIDER = { providerId: 'mock-provider', modelId: 'mock-model' } as const
