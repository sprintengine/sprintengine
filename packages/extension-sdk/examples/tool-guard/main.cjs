// Tool guard: a worker that hooks agents' tool calls.
//
// Before a call runs, it refuses a shell command that deletes recursively and
// by force (`rm -rf`, `rm -fr`, `rm -r -f`, `rm --recursive --force`), also
// quoted (`"rm" '-rf'`), escaped (`\rm`) or nested in another command
// (`$(rm -rf x)`, backticks, `bash -c "rm -rf x"`, a subshell). The
// agent reads the reason, with this extension's name, and carries on. Its
// entry in extension.json says `"onError": "deny"`, so should this hook ever
// fail or answer late, the call is refused rather than let through.
//
// After a call finishes, it writes one line to its log (Settings ▸ Extensions
// ▸ Tool guard ▸ Log). It only observes: Studio does not wait for it.

const SHELL_TOOLS = new Set(['Bash', 'BashOutput', 'shell', 'exec_command'])

/** Whether a command line deletes recursively and by force. */
function deletesByForce(command) {
  // Quotes and escapes taken out, so `"rm" -rf` and `bash -c "rm -rf x"` read
  // as the words the shell runs; every nested command is a segment of its own.
  const plain = command.replace(/\\(.)/g, '$1').replace(/["']/g, '')
  for (const segment of plain.split(/&&|\|\||;|\||\n|\$\(|`|[(){}]/)) {
    const words = segment.trim().split(/\s+/)
    const at = words.findIndex((word) => word === 'rm' || word.endsWith('/rm'))
    if (at < 0) continue
    let recursive = false
    let force = false
    for (const word of words.slice(at + 1)) {
      if (word === '--') break
      if (word === '--recursive') recursive = true
      else if (word === '--force') force = true
      else if (/^-[a-zA-Z]+$/.test(word)) {
        if (/[rR]/.test(word)) recursive = true
        if (word.includes('f')) force = true
      }
    }
    if (recursive && force) return true
  }
  return false
}

exports.deletesByForce = deletesByForce

exports.activate = (studio) => {
  studio.registerHooks({
    'agent.tool.before': (event) => {
      const command = typeof event.input.command === 'string' ? event.input.command : null
      if (!SHELL_TOOLS.has(event.tool) || command === null) return undefined
      if (deletesByForce(command))
        return {
          deny: 'it deletes files recursively and by force (rm -rf). Remove the files you mean by name instead.',
        }
      return undefined
    },
    'agent.tool.after': (event) => {
      console.log(`${event.failed ? 'failed' : 'finished'}: ${event.tool} in ${event.workspaceId}/${event.agentId}`)
    },
  })
}
