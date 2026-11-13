// Publishing a local dev server on the tailnet: the contract Settings, the
// browser pane (`tailnet.share*`) and the mobile snapshot all read.
//
// A share is machine state, not app state. `tailscale serve --bg` outlives the
// Studio process, so this contract never describes "what we turned on this
// session" — it describes what the daemon reports right now. That is why every
// view carries the full list rather than a delta, and why `available` is a
// first-class field: a machine with Tailscale uninstalled is a normal answer,
// not an error.

import { type TailnetShareStatus } from '../../packages/studio-protocol/src/tailnet-types'
// The wire shapes, defined once in the protocol package.
export type {
  TailnetShareView,
  TailnetShareStatus,
  TailnetShareResult,
} from '../../packages/studio-protocol/src/tailnet-types'

export const EMPTY_TAILNET_SHARE_STATUS: TailnetShareStatus = {
  available: false,
  dnsName: null,
  shares: [],
  ladderFull: false,
}
