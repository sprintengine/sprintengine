// The `window.api` channels the Studio server owns when it runs in a process
// of its own (phase 6 spec, 6.2). Out of process, the preload routes an invoke
// or send on one of these over the window's port; every other channel stays
// with the shell. In process everything goes to main, as it always has.
//
// A domain is listed whole when its registration moves into the server, and
// the inventory test (src/main/ipc-inventory.test.ts) holds this table and the
// server's registrations to each other in both directions. When a domain's
// channels become typed protocol methods, its entries leave this table and
// its rows leave the IPC inventory (shared/ipc-inventory.ts); the tunnel is
// done when the table is empty.
//
// `retry: 'once'` marks an idempotent read the preload sends again, once, on
// the next port when the server restarts under it.
//
// `subscription` marks a channel that registers a subscription on the server,
// keyed to the window's port: a new port (the server restarted, a web tab's
// socket reconnected) starts with none, so the router makes each live one
// again on the next port. The id it is undone by is either one the caller
// chose (in the first argument's `subscriptionId`) or one the server answered
// with; for the latter, the router keeps the caller's id and sends the
// server's current one when it is undone.

export type ServerIpcSubscription = { unsubscribe: string; id: 'argument' | 'result' }

export type ServerIpcChannel = { retry?: 'once'; subscription?: ServerIpcSubscription }

const SERVER_IPC_CHANNEL_TABLE = {
  'hosts:home': { retry: 'once' },
  'hosts:list': { retry: 'once' },
  // The Schedules window's (registered with the server's domains, refused
  // while scheduled agents is off).
} as const satisfies Readonly<Record<string, ServerIpcChannel>>

/** Every channel the server owns, by name: what a table keyed by channel must cover (`WEB_TUNNEL_ACCESS`). */
export type ServerIpcChannelName = keyof typeof SERVER_IPC_CHANNEL_TABLE

export const SERVER_IPC_CHANNELS: Readonly<Record<string, ServerIpcChannel>> = SERVER_IPC_CHANNEL_TABLE
