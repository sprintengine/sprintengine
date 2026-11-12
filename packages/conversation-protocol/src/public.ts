// The package's entry: the whole conversation contract. The phone app imports
// it from this repository's source, as the desktop does, so both build against
// the same files. A desktop and a phone still run different versions of it,
// which is what the lane's capabilities are for (docs/compatibility.md).
export * from './index.js'
export * from './serverFrames.js'
export * from './events.js'
export * from './commands.js'
export * from './handshake.js'
export * from './clientFrames.js'
export * from './agentReads.js'
// What a client's composer reads from the desktop beside the socket.
export * from './composerReads.js'
// A chat's changes, read as the desktop's own Diff tab reads them.
export * from './checkoutChanges.js'
// How a tool step is worded and toned, which every view of a conversation shares.
export * from './presentation.js'
// A live session's summary and what its session methods answer.
export * from './sessions.js'
// What a message carries beside its words: mentions and files attached by path.
export * from './messageParts.js'
