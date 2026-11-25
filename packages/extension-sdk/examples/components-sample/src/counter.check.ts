// The states `sprintengine-extension check` renders the counter in.

import { defineCheck } from '@sprintengine/extension-sdk/testing'

export default defineCheck({
  fresh: {},
  'pressed before': { persisted: { plugin: { 'counter.count': 7 } } },
  dark: { theme: 'dark', persisted: { plugin: { 'counter.count': 1 } } },
})
