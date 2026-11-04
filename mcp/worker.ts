import { serveTool } from '../core/actions'
import { BOARD_TOOLS, TOOL_PREFIX, TOOL_SPECS } from '../core/contract'
import type { Io } from '../core/ports'
import { bunCodeHost } from './code-host'
import type { ServedTool } from './protocol'
import type { SqliteBoards } from './sqlite-store'

/**
 * The worker mode of `meld mcp`: the board tools of one agent on one board, as an ACP agent such as Codex calls them.
 * The agent id names the worker, as the agent id of a subagent does in the plugin.
 */
export type WorkerPlace = { board: string; agent: string }

const WORKER_TOOLS: readonly string[] = BOARD_TOOLS

export function workerTools(io: Io, place: WorkerPlace): ServedTool[] {
  return TOOL_SPECS.filter(spec => WORKER_TOOLS.includes(`${TOOL_PREFIX}${spec.name}`)).map(spec => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema ?? { type: 'object', properties: {} },
    answer: async args => JSON.parse((await serveTool(io, { ...args, tool: `${TOOL_PREFIX}${spec.name}`, agentId: place.agent })).result) as unknown,
  }))
}

/**
 * The ports of the worker mode. The run is on the board in SQLite; commands run in this process. Only the leader starts
 * agents and reaches the other agents and the person, so a message or a toast becomes an action row for the leader.
 */
export function workerIo(boards: SqliteBoards, place: WorkerPlace): Io {
  return {
    ...boards.board(place.board),
    readFacts: async () => null,
    writeFacts: async () => undefined,
    ...bunCodeHost,
    spawn: async () => ({ deny: 'a worker of meld mcp starts no agent: the leader does' }),
    send: async (agent, text) => boards.addAction({ board: place.board, kind: 'send', agent, text, at: Date.now() }),
    agents: async () => undefined,
    now: async () => Date.now(),
    sleep: ms => Bun.sleep(ms),
    random: count => crypto.getRandomValues(new Uint8Array(count)),
    toast: text => boards.addAction({ board: place.board, kind: 'toast', agent: '', text, at: Date.now() }),
    openPane: async () => undefined,
    command: async () => ({}),
    cost: async () => undefined,
  }
}
