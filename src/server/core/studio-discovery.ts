import type {
  StudioCliRuntime,
  StudioWorkspace,
  StudioWorkspaceCheckout,
  StudioWorkspaceExtensions,
} from '../../../packages/studio-protocol/src/public'
import type { McpToolRegistration, McpToolResult } from '../../shared/modules/mcp-tools'
import type { StudioDiscovery, StudioDiscoveryAnswer } from '../rpc/studio-rpc-types'

// What a Studio protocol client reads before it starts a chat, answered by the
// gateway's own tools of the same purpose: `workspace.list`, `cli.runtime.list`,
// `workspace.checkout` and `workspace.extensions`. One implementation, so the
// phone and a paired desktop on the protocol read exactly what an agent on MCP
// reads, and a change to one is a change to both.
//
// The tools are asked with no connection context: these are reads of this
// machine's own state, the same for every caller. Who may ask is the
// protocol's grant check, made before this is reached.

/** The tools this reads, by name; a Studio without one answers that read `unavailable`. */
export const STUDIO_DISCOVERY_TOOLS = {
  workspaces: 'workspace.list',
  runtimes: 'cli.runtime.list',
  checkout: 'workspace.checkout',
  extensions: 'workspace.extensions',
} as const

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A refusal whose code names something this Studio does not hold is `not_found`; any other is `unavailable`. */
function refusalCode(code: string): 'not_found' | 'unavailable' {
  return code.startsWith('unknown_') || code === 'workspace_folder_missing' ? 'not_found' : 'unavailable'
}

/** A tool's answer as a discovery read's: its structured content, or its refusal. */
export function readDiscoveryToolResult(result: McpToolResult): StudioDiscoveryAnswer<Record<string, unknown>> {
  const structured = result.structuredContent
  const error = record(structured?.error) ? structured.error : null
  if (result.isError || error || !structured) {
    const code = typeof error?.code === 'string' ? error.code : 'unavailable'
    const message = typeof error?.message === 'string' ? error.message : 'This Studio could not answer.'
    return { ok: false, code: refusalCode(code), message }
  }
  return { ok: true, value: structured }
}

export function createStudioDiscovery(tools: () => McpToolRegistration[]): StudioDiscovery {
  async function call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<StudioDiscoveryAnswer<Record<string, unknown>>> {
    const tool = tools().find((entry) => entry.name === name)
    if (!tool) return { ok: false, code: 'unavailable', message: `This Studio does not serve ${name}.` }
    return readDiscoveryToolResult(await tool.handler(args))
  }
  return {
    async workspaces() {
      const answer = await call(STUDIO_DISCOVERY_TOOLS.workspaces, {})
      if (!answer.ok) throw new Error(answer.message)
      const rows = Array.isArray(answer.value.workspaces) ? answer.value.workspaces : []
      return rows.filter(
        (row): row is StudioWorkspace => record(row) && typeof row.id === 'string' && typeof row.name === 'string',
      )
    },
    async runtimes(cli) {
      const answer = await call(STUDIO_DISCOVERY_TOOLS.runtimes, cli ? { cli } : {})
      if (!answer.ok) return answer
      const clis = Array.isArray(answer.value.clis) ? answer.value.clis : []
      return {
        ok: true,
        value: { clis: clis.filter((row): row is StudioCliRuntime => record(row) && typeof row.id === 'string') },
      }
    },
    async checkout(workspaceId) {
      const answer = await call(STUDIO_DISCOVERY_TOOLS.checkout, { workspaceId })
      if (!answer.ok) return answer
      return {
        ok: true,
        value: { ...answer.value, workspaceId, git: answer.value.git === true } as StudioWorkspaceCheckout,
      }
    },
    async extensions(workspaceId, cli) {
      const answer = await call(STUDIO_DISCOVERY_TOOLS.extensions, { workspaceId, ...(cli ? { cli } : {}) })
      if (!answer.ok) return answer
      const skills = Array.isArray(answer.value.skills) ? answer.value.skills : []
      return {
        ok: true,
        value: {
          ...answer.value,
          workspaceId,
          skills: skills.filter((skill) => record(skill) && typeof skill.id === 'string'),
        } as StudioWorkspaceExtensions,
      }
    },
  }
}
