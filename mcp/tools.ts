import type { Run } from '../types'
import type { AcpRunner } from './leader'
import { isRecord } from './protocol'
import type { ServedTool } from './protocol'
import type { SqliteBoards } from './sqlite-store'

const ONLY_MELD = 'Only the meld plugin calls this tool.'
const BOARD = { type: 'string', description: 'The id of the board: one board holds the run of one session.' }
const OWNER = { type: 'string', description: 'The id of the session that writes.' }
const READ_ONLY = { readOnlyHint: true }
const AGENT = { type: 'string', description: 'The agent id of an ACP agent, acp-...' }

/** The tools of `meld mcp`: the boards in its SQLite file, which the meld plugin reads and writes as its store. */
export function boardTools(boards: SqliteBoards, now: () => number): ServedTool[] {
  return [
    {
      name: 'read_board',
      description: `${ONLY_MELD} Reads a board: its run, the version of its last write, and the session that owns it.`,
      inputSchema: schema({ board: BOARD }),
      annotations: READ_ONLY,
      answer: args => boards.read(text(args, 'board')),
    },
    {
      name: 'commit_board',
      description: `${ONLY_MELD} Stores a run when the board is still at the version that the caller read.`,
      inputSchema: schema({ board: BOARD, run: { type: ['object', 'null'] }, version: { type: 'integer', minimum: 0 }, owner: OWNER }),
      answer: args => ({ result: boards.commit(text(args, 'board'), runOf(args), version(args), text(args, 'owner'), now()) }),
    },
    {
      name: 'list_boards',
      description: `${ONLY_MELD} Lists the boards that hold a run, so a new session can resume one.`,
      inputSchema: schema({}),
      annotations: READ_ONLY,
      answer: () => ({ boards: boards.list() }),
    },
    {
      name: 'run_records',
      description: `${ONLY_MELD} Gives what the file keeps of each run beside the boards: its board, state, version control, repository, base and workers, and its last change.`,
      inputSchema: schema({}),
      annotations: READ_ONLY,
      answer: () => ({ runs: boards.runRecords() }),
    },
    {
      name: 'adopt_board',
      description: `${ONLY_MELD} Gives a board to a session, when its owner wrote nothing for the time of a lease.`,
      inputSchema: schema({ board: BOARD, owner: OWNER }),
      answer: args => {
        const adopted = boards.adopt(text(args, 'board'), text(args, 'owner'), now())
        return typeof adopted === 'string' ? { result: adopted } : { result: 'busy', ...adopted }
      },
    },
  ]
}

/** The tool that names the board channel of this process: the Unix socket where the timer of the pane reads the boards. */
export function channelTool(socketPath: string): ServedTool {
  return {
    name: 'board_channel',
    description: `${ONLY_MELD} Names the Unix socket where this process answers the reads of boards over HTTP, or an empty text when it has none.`,
    inputSchema: schema({}),
    annotations: READ_ONLY,
    answer: () => ({ socketPath }),
  }
}

/** The tools of the ACP runner of the leader: the plugin starts, reaches and stops the ACP workers of its board through them. */
export function runnerTools(runner: AcpRunner, boards: SqliteBoards): ServedTool[] {
  return [
    {
      name: 'lead_board',
      description: `${ONLY_MELD} Makes this process the leader of the ACP workers of a board, while the session owner owns it: it starts them again when work waits for them.`,
      inputSchema: schema({ board: BOARD, owner: OWNER }),
      answer: args => {
        runner.lead(text(args, 'board'), text(args, 'owner'))
        return { ok: true }
      },
    },
    {
      name: 'spawn_worker',
      description: `${ONLY_MELD} Starts an ACP agent, such as Codex, for a worker of a board, in the folder of the worker. Answers with the agent id, or why it did not start.`,
      inputSchema: schema({ board: BOARD, subagentType: { type: 'string' }, cwd: { type: 'string' }, prompt: { type: 'string' }, description: { type: 'string' } }),
      answer: args => runner.spawn(text(args, 'board'), { subagentType: text(args, 'subagentType'), cwd: text(args, 'cwd'), prompt: text(args, 'prompt'), description: text(args, 'description') }),
    },
    {
      name: 'send_worker',
      description: `${ONLY_MELD} Gives a message to an ACP agent: a new prompt in its session, after the prompt that it runs.`,
      inputSchema: schema({ agent: AGENT, text: { type: 'string' } }),
      answer: async args => {
        await runner.send(text(args, 'agent'), text(args, 'text'))
        return { ok: true }
      },
    },
    {
      name: 'stop_worker',
      description: `${ONLY_MELD} Stops an ACP agent.`,
      inputSchema: schema({ agent: AGENT }),
      answer: async args => {
        await runner.stop(text(args, 'agent'))
        return { ok: true }
      },
    },
    {
      name: 'acp_agents',
      description: `${ONLY_MELD} Gives the liveness of each ACP agent: live while it starts or runs a prompt, ended when its turn is over.`,
      inputSchema: schema({}),
      annotations: READ_ONLY,
      answer: () => ({ agents: Object.fromEntries(runner.states()) }),
    },
    {
      name: 'take_actions',
      description: `${ONLY_MELD} Takes the work for the plugin that the workers of meld mcp left on a board: messages to its subagents, and toasts.`,
      inputSchema: schema({ board: BOARD }),
      answer: args => ({ actions: boards.takeActions(text(args, 'board'), 'engine') }),
    },
  ]
}

function schema(properties: Record<string, object>): Record<string, unknown> {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }
}

function text(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || !value) throw new Error(`${name} is a text that is not empty.`)
  return value
}

function version(args: Record<string, unknown>): number {
  const value = args.version
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error('version is a whole number, 0 or more.')
  return value
}

function runOf(args: Record<string, unknown>): Run | null {
  const value = args.run
  if (value === null) return null
  if (!isRecord(value) || typeof value.id !== 'string' || !Array.isArray(value.tasks)) throw new Error('run is a meld run, or null.')
  return value as unknown as Run
}
