# Tool guard: agent hooks

A sample worker extension (`"tier": "worker"`) that hooks agents' tool calls:

- `agent.tool.before` refuses a shell command that deletes recursively and by
  force (`rm -rf` and its spellings). The agent reads why, with the
  extension's name, and the chat goes on. Its entry says
  `"onError": "deny"`: should the hook fail or answer after two seconds, the
  call is refused rather than let through.
- `agent.tool.after` writes a line to the extension's log for each call an
  agent finishes. It only observes; Studio does not wait for it.

Install it from this folder in Settings ▸ Extensions and approve it: the
approval names both hooks in plain words. Then ask an agent in a Claude Code
chat to run `rm -rf build`. Studio's tests run this worker as it is.
