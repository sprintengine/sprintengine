// The package's entry: the Studio protocol, and the conversation contract it
// carries.
//
// Everything `@sprintengine/conversation-protocol` exports is re-exported
// here, so a client depends on this one package. The conversation package
// stays what it is — the conversation lane on its own, which the phone app
// carries byte for byte — and this one adds the connection around it.
export * from './conversation.js'
export * from './scopes.js'
export * from './handshake.js'
export * from './envelope.js'
// How a method and a topic are defined, once, building both ends.
export * from './contract.js'
export * from './methods.js'
export * from './chat.js'
export * from './followed.js'
export * from './providers.js'
export * from './discovery.js'
export * from './tools.js'
export * from './files.js'
export * from './pull-requests.js'
export * from './local-servers.js'
// The terminals on a Studio's machine, and the agent vocabulary their sessions are described in.
export * from './agents.js'
export * from './terminals.js'
// How a Studio runs its agents' CLIs, and the settings every launch reads.
export * from './agent-settings.js'
// What a Studio's agents are set up with beyond their CLIs.
export * from './agent-setup.js'
// Keeping a Studio up to date, and reaching one whose protocol does not meet the client's.
export * from './update.js'
export * from './modules.js'
export * from './permissions.js'
export * from './environment.js'
// `sprintengine://` links: the one grammar every client reads and writes.
export * from './chat-link.js'
