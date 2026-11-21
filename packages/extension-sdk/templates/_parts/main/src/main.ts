import type { MainHost, ModuleMethodParsed } from '@sprintengine/extension-sdk'

import type { MainMethods } from './methods'

// The worker: Studio loads extension/dist/main.cjs with require and calls
// `activate` once, with a `studio` for this extension (Node, no window).
// Register here what the surfaces call, what agents call, and what the
// commands extension.json declares without an `action` run: such a command
// calls the `operate` method of its own id.
//
// `status` is a method a surface calls with
// `studio.methods<MainMethods>().read('status', {})`; declaring methods needs
// the "module:bridge" permission. Each method says who may call it (`read`, or
// `operate` for one that changes something), reads its params, and answers
// `{ ok: true, result }` or its own `{ ok: false, code, message }`. Replace it
// with the extension's own; their contract is in ./methods.ts.
const noParams = (): ModuleMethodParsed<Record<string, never>> => ({ ok: true, params: {} })

export function activate(studio: MainHost): void {
  const startedAt = Date.now()
  studio.registerMethods<MainMethods>({
    status: { access: 'read', params: noParams, handler: () => ({ ok: true, result: { startedAt } }) },
  })
}
