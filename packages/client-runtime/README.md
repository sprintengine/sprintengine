# @sprintengine/client-runtime

What every SprintEngine Studio client runs, whatever draws it: the desktop
window, a web page, a script through
[`@sprintengine/agent-sdk`](../agent-sdk/README.md), and the phone app.

- **`connect({ transport, client, auth })`**: the client of
  [`@sprintengine/studio-protocol`](../studio-protocol/README.md) over any
  transport that carries whole frames. One connection with every request and
  stream multiplexed on it: requests typed by the protocol's method table
  (`client.request`, or `client.rpc`, one call per method), conversation
  streams resumed from their cursors after a drop, mutations resent under
  their command ids where that cannot carry them out twice (to the same
  server boot, or anywhere for a method whose receipts are durable; otherwise
  refused `unknown_outcome`), push topics, tools offered to Studio's agents, a
  heartbeat, and backpressure from a consumer that falls behind.
- **`ConnectionSupervisor`**: one owner for a connection that has to stay up:
  an explicit state machine (`idle`, `connecting`, `up`, `backoff`,
  `waiting-for-wake`, `needs-sign-in`, `failed`, `stopped`), retries that never
  give up and count time spent trying rather than time asleep, a wake that
  pings a live connection instead of closing it, and a refused credential that
  waits for a person. The clock, timers and randomness are injectable.

The fold of a conversation's events into the rows a view draws is
[`@sprintengine/conversation-timeline`](../conversation-timeline/README.md),
held to the same rules below.

## Runs anywhere

Nothing here imports Node, touches a DOM or needs React. The build, and the
repository's `npm run typecheck` (`tsconfig.portable.json`), compile it with
`lib: ES2023`, no DOM and no Node types, and only the globals in
`portable/globals.d.ts`, which React Native, a browser and Node all provide.
Reaching for anything else fails to compile.

The phone app imports this package's source from the repository. Its
`npm run ci` compiles the supervisor's and the conversation timeline's tests
with the phone's compiler settings and runs them on `node --test`
(`mobile/scripts/vitest-bridge.cjs` answers their `vitest` imports), so the
same files pass in both suites.

## Transports

A transport is anything that carries whole frames both ways
(`StudioTransport`): Node's owner socket (`@sprintengine/agent-sdk/node`), a
WebSocket (a desktop window's too, to its server's window listener), or a test
double. `StudioTransportFactory` is
called again for every reconnect, so it may find Studio somewhere new.
