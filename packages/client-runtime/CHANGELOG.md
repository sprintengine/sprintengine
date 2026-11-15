# Changelog

## Unreleased

### Fixed

- A protocol mismatch names the side to update. `presentStudioFailure(error)`
  reads any failed ask into one kind a client acts on (`client-outdated`,
  `server-outdated`, `incompatible`, `unauthorized`, `forbidden`,
  `connection`, `refused`) and words a person can act on; a version refusal is
  judged from the Studio's window (`StudioError.studio`, from the `bye` or the
  welcome), never from the refusal's words. `isStudioVersionFailure(kind)`
  says which kinds are final until one side updates. The desktop window, its
  main process and the phone read their failures through it.
- A mutation still unanswered when its connection dropped is sent again only
  where that cannot carry it out twice: to the same run of the server
  (`welcome.bootId`), or anywhere for a method whose receipts are durable. One
  sent to a server that has since restarted is refused `unknown_outcome`, with
  a sentence a UI can show. Reads, streams, and requests that never went out
  are unchanged.

### Added

- `negotiateChatCapabilities(offer)`: what a chat may offer, read from what its
  server said (a Studio's welcome, or a paired desktop's lane until it is on
  the Studio protocol). A control is offered where the Studio serves the
  method behind it and the grant reaches it (`studioOffers`); `grant.owner` is
  never read. Studio's own windows, a paired machine's chat and the embedded
  view all read their chats' capabilities through it.
- The package. The Studio protocol's client (`connect`, the conversation
  service and handles, client tools, `StudioError`) moved here from
  `@sprintengine/agent-sdk`, which re-exports it, and the connection
  supervisor moved here from the private `connection-supervisor` package.
- `webSocketTransport({ ticket })`: a fresh WebSocket per connection, each
  with the URL and credential `ticket()` gives it, given up on if it has not
  opened within ten seconds. Studio's own windows and the web tab connect
  with it.
- `client.rpc`: one call per protocol method, built from the method table by
  `createStudioRpcClient`.
- `openStudioUpdateSession`: one connection to a Studio whose protocol
  window does not meet this client's, kept for `update.status` and
  `update.start` (`update-session`). `@sprintengine/agent-sdk` re-exports it.
- `createFrameQueue`, the queue a conversation stream's frames wait in, for
  adapters that turn callbacks into a stream.

### Changed

- The client reconnects through the connection supervisor rather than a loop
  of its own, so it keeps the rules every client shares. A wake while open
  (`wake()`, or the page coming back to the foreground) pings Studio and keeps
  a connection that answers, making one that does not again at once; a wake
  during a backoff tries at once, but never sooner than a delay Studio asked
  for; a connection that drops as soon as it opens still backs off, since the
  count of failures resets only once one has stayed up for thirty seconds.
  Tickets are still asked for per connection, a refused credential still parks
  the client, and offline still waits for the network.
- `ConnectionFailureVerdict` gains `wait-for-wake`: worth another try, but
  only after a wake (the device is offline), not on a timer.
