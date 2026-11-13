// Tailnet peer discovery: the CLIENT half of tailnet remote control.
//
// `tailnet.ts` carries the contracts for configuring THIS machine's listener.
// These are the contracts for finding OTHER machines: which nodes the tailnet
// has, and which of them answer as a Studio. Separate files because they are
// separate directions — one is "who may drive me", the other is "who can I
// drive" — and the panel that shows both is the only place they meet.
//
// The main-process implementation is `src/main/automation/tailnet/tailnet-peers.ts`.

// The wire shapes, defined once in the protocol package.
export type { TailnetPeerStudio, TailnetPeer, TailnetPeerScan } from '../../packages/studio-protocol/src/tailnet-types'
