import { serveTool } from '../core/actions'
import { TOOL, TOOL_PREFIX, TOOL_SPECS } from '../core/contract'
import { DEFAULT_AGENTS } from '../core/options'
import type { Io, ToolSpec } from '../core/ports'
import type { Action } from '../core/remote-store'
import type { ServedTool } from './protocol'
import type { SqliteBoards } from './sqlite-store'

/** The tools of the main session that a chat calls. */
const CHAT_TOOLS: readonly string[] = [TOOL.start, TOOL.board, TOOL.steer, TOOL.stop, TOOL.deliver, TOOL.discard, TOOL.addWorker]
const COUNT = /^\d+$/
const ACP_NAMES = 'codex, gemini, cursor, or a name of MELD_ACP_AGENTS'
const CHAT_START =
  'Start a meld run when the person asks for one: several ACP agents work on the request at the same time, each in its own workspace. Read the board to watch them, and deliver the final commit when the run is ready.'
const CHAT_AGENTS = { type: 'string', description: `A count from 1 to 8 of the default ACP agent, or ACP agents split by commas: ${ACP_NAMES}. Default 2.` }
const CHAT_AGENT = { type: 'string', description: `An ACP agent: ${ACP_NAMES}. Default: the agent of w1.` }

/** Where a chat leads its run: the board, and the folder where a start looks for the repository. */
export type ChatPlace = { board: string; cwd: string; defaultAgent: string }

/**
 * The chat mode of `meld mcp`: the tools of the main session for an MCP client that leads a run, such as a chat of
 * Cursor. Each call runs serveTool of the core, as the start, steer and board tools of the plugin do. The workers are ACP
 * agents, and the board reply carries the notices that Claude Code shows as toasts.
 */
export function chatTools(io: Io, boards: SqliteBoards, place: ChatPlace): ServedTool[] {
  return TOOL_SPECS.filter(spec => CHAT_TOOLS.includes(`${TOOL_PREFIX}${spec.name}`)).map(chatSpec).map(spec => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema ?? { type: 'object', properties: {} },
    answer: async args => {
      const call = { ...chatArgs(spec.name, args, place.defaultAgent), tool: `${TOOL_PREFIX}${spec.name}` }
      const value = JSON.parse((await serveTool(io, call, place.cwd)).result) as Record<string, unknown>
      return spec.name === 'board' ? withNotices(value, boards.takeActions(place.board, 'engine')) : value
    },
  }))
}

/** The tool as a chat reads it: its workers are ACP agents, and an ACP agent picks its own model, so a start has no model field. */
function chatSpec(spec: ToolSpec): ToolSpec {
  if (spec.name === 'start') return { ...spec, description: CHAT_START, inputSchema: withProperties(spec, { agents: CHAT_AGENTS }, ['model']) }
  if (spec.name === 'add_worker') return { ...spec, inputSchema: withProperties(spec, { agent: CHAT_AGENT }, []) }
  return spec
}

function withProperties(spec: ToolSpec, replaced: Record<string, object>, dropped: readonly string[]): Record<string, unknown> {
  const properties = { ...((spec.inputSchema?.properties as Record<string, object> | undefined) ?? {}), ...replaced }
  for (const name of dropped) delete properties[name]
  return { ...spec.inputSchema, properties }
}

/** A chat has no Claude subagents: a start that names no agents, or only a count, gets the default ACP agent. */
export function chatArgs(tool: string, args: Record<string, unknown>, defaultAgent: string): Record<string, unknown> {
  if (tool !== 'start') return args
  const agents = typeof args.agents === 'string' ? args.agents.trim() : ''
  if (agents && !COUNT.test(agents)) return args
  const count = agents ? Number(agents) : DEFAULT_AGENTS
  return { ...args, agents: Array.from({ length: count }, () => defaultAgent).join(',') }
}

/** The toasts that the workers left for the person; a message to an agent that no ACP runner holds has no one to reach. */
function withNotices(value: Record<string, unknown>, actions: readonly Action[]): Record<string, unknown> {
  const notices = actions.filter(action => action.kind === 'toast').map(action => action.text)
  return notices.length ? { ...value, notices } : value
}
