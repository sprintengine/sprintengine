import { mayRegisterIpcChannel } from '../../shared/ipc-inventory'

// Which channels main may register (shared/ipc-inventory.ts), plus the ones a
// module's main half registers through `MainHost.registerIpc`. Those are named
// by each module, an installed extension's included, so no table can list
// them ahead of time; the module kernel notes each one as it registers it,
// and the kernel's IPC is the module contract's to replace with declared
// protocol methods.

const moduleChannels = new Set<string>()

/** Called by the module kernel just before it registers a module's channel. */
export function noteModuleIpcChannel(channel: string): void {
  moduleChannels.add(channel)
}

/** Whether main may register a handler or listener on `channel`. */
export function mayRegisterInMain(channel: string): boolean {
  return mayRegisterIpcChannel(channel) || moduleChannels.has(channel)
}
