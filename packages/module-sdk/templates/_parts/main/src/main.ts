import type { ModuleMethodParsed, RegisterMain } from '@sprintengine/module-sdk'

import type { MainMethods } from './methods'

// The main entry runs where Studio runs this module's background half (Node,
// no window), once, when the module loads. Register here what the window half
// calls, what agents call, and what runs in the background. A service
// resolved here, at the top, needs its provider in `dependsOn`
// ("agent-runtime" is declared); one resolved inside a handler does not.
//
// `status` is a method the window half calls with
// `host.methods<MainMethods>().read('status', {})`; declaring methods needs
// the "module:bridge" permission. Each method says who may call it (`read`, or
// `operate` for one that changes something), reads its params, and answers
// `{ ok: true, result }` or its own `{ ok: false, code, message }`. Replace it
// with the module's own; their contract is in ./methods.ts.
const noParams = (): ModuleMethodParsed<Record<string, never>> => ({ ok: true, params: {} })

export const registerMain: RegisterMain = (host) => {
  const startedAt = Date.now()
  host.registerMethods<MainMethods>({
    status: { access: 'read', params: noParams, handler: () => ({ ok: true, result: { startedAt } }) },
  })
}
