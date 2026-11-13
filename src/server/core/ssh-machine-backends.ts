import type { RemoteConversationBackend } from '../wsl/backend-wire'

// An SSH machine's backend wire, as the desktop still reaches it for the two
// things not yet on the machine's own Studio protocol: the Files and Git
// panes' machine channels (`core.sshMachineCall`, design-wsl-ssh-direct PR 2)
// and the desktop's toolsets relayed to the machine's agents. A machine's
// chats never go over it: they are the machine's Studio's (PR 1d). Keyed
// `ssh:<saved id>`.

export type SshMachineBackend = { key: string; label: string; backend: RemoteConversationBackend }

export type SshMachineBackends = {
  connect(key: string): Promise<SshMachineBackend>
  current(key: string): SshMachineBackend | null
}
