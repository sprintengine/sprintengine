import type { RendererIpc } from '../../../preload/ipc-router'
import { webShellIpc } from './webShellIpc'

// A web tab's IPC: what `src/preload/ipc-router.ts` is in a desktop window,
// and what the web build puts in its place. IPC carries the shell's channels
// alone, and a browser has no shell: every one of them is refused here
// (`webShellIpc`). What a tab reaches of its Studio, it reaches on the Studio
// protocol, as a desktop window does.

export type { RendererIpc } from '../../../preload/ipc-router'

export const ipc: RendererIpc = webShellIpc
