// The states `npm run check` (and `npm run dev`'s check after each save)
// renders the panel in, against the SDK's fake Studio: each scenario is one
// render, and the check says what it drew, what threw, and the props, renders
// and calls Studio would refuse. A scenario takes the fake's `persisted`
// atoms, `storage`, `settings`, `secrets`, `results` (answers by host
// method), `theme`, `visible`, `workspaces`, `files`, and `events` delivered
// after the first draw.

import { defineCheck } from '@sprintengine/extension-sdk/testing'

export default defineCheck({
  empty: {},
  'with items': {
    persisted: {
      workspace: {
        items: [
          { id: 'milk', text: 'Buy milk', done: false },
          { id: 'plumber', text: 'Call the plumber', done: true },
        ],
      },
    },
  },
})
