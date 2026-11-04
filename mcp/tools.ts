import type { Run } from '../types'
import { isRecord } from './protocol'
import type { ServedTool } from './protocol'
import type { SqliteBoards } from './sqlite-store'

const ONLY_MELD = 'Only the meld plugin calls this tool.'
const BOARD = { type: 'string', description: 'The id of the board: one board holds the run of one session.' }
const OWNER = { type: 'string', description: 'The id of the session that writes.' }
const READ_ONLY = { readOnlyHint: true }

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
