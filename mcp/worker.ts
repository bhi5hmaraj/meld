import { serveTool } from '../core/actions'
import { BOARD_TOOLS, TOOL_PREFIX, TOOL_SPECS } from '../core/contract'
import type { Io } from '../core/ports'
import type { ServedTool } from './protocol'

/**
 * The worker mode of `meld mcp`: the board tools of one agent on one board, as an ACP agent such as Codex calls them.
 * The agent id names the worker, as the agent id of a subagent does in the plugin.
 */
export type WorkerPlace = { board: string; agent: string }

const WORKER_TOOLS: readonly string[] = BOARD_TOOLS

/** The tools of a worker over the ports of `meld mcp` (mcpIo): each call runs serveTool of the core, as in the plugin. */
export function workerTools(io: Io, place: WorkerPlace): ServedTool[] {
  return TOOL_SPECS.filter(spec => WORKER_TOOLS.includes(`${TOOL_PREFIX}${spec.name}`)).map(spec => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema ?? { type: 'object', properties: {} },
    answer: async args => JSON.parse((await serveTool(io, { ...args, tool: `${TOOL_PREFIX}${spec.name}`, agentId: place.agent })).result) as unknown,
  }))
}
