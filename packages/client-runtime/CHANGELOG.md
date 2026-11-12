# Changelog

## Unreleased

### Added

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
- `createFrameQueue`, the queue a conversation stream's frames wait in, for
  adapters that turn callbacks into a stream.
