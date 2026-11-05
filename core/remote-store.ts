import type { Run } from '../types'
import type { Store } from './ports'

/** A board as a server gives it: the run, and the version of the last write. */
export type BoardRead = { run: Run | null; version: number }

/** What a commit did: stored, refused for an old version, refused as another session holds the lease, or refused by a newer file. */
export type Committed = 'committed' | 'stale' | 'taken' | 'newer schema'

/** Work that only the leader of a board can do, left by a worker of `meld mcp`: a message to an agent, or a toast to the person. */
export type Action = { id: number; board: string; kind: 'send' | 'toast'; agent: string; text: string; at: number }

/** A board with a run, for a session that looks for a run to resume. */
export type BoardSummary = { board: string; run: string; state: string; request: string; repo: string; owner: string | null; ownerAt: number | null }

/** What an adopt did: the session owns the board now, there is no run on it, or another session holds its lease. */
export type Adopted = 'adopted' | 'missing' | { owner: string; ownerAt: number }

/** The boards of the machine, for a resume in a new session. */
export type Boards = {
  /** The board of this session. */
  current(): string
  list(): Promise<BoardSummary[]>
  adopt(board: string): Promise<Adopted>
  /** This session works on `board` from now on. */
  use(board: string): Promise<void>
}

/** A board that another process keeps, such as `meld mcp` with its SQLite file: reads, and commits that compare versions. */
export type BoardServer = {
  read(): Promise<BoardRead>
  commit(run: Run | null, version: number): Promise<Committed>
}

/** Where a host keeps a copy of the run for its screen, such as the session state that the pane draws from. */
export type BoardCache = (run: Run | null) => Promise<unknown>

/** How many times a write reads and commits again after a lost race, before it gives up. */
const TRIES = 8

const REFUSED: Record<Exclude<Committed, 'committed' | 'stale'>, string> = {
  taken: 'meld: another session works on this run now, so this session changes nothing on it',
  'newer schema': 'meld: a newer meld keeps the board file: restart the session, so it loads the newer meld',
}

/**
 * A Store over a board server. A write reads the board, runs the change, and commits it at the version that it read;
 * after a lost race it reads and runs the change again. A change that leaves the run as it was commits nothing. A read
 * that finds a new version refreshes the cache.
 */
export function remoteStore(server: BoardServer, cache?: BoardCache): Store {
  let seen: number | undefined
  const refreshed = async (board: BoardRead): Promise<BoardRead> => {
    if (board.version !== seen) await cache?.(board.run)
    seen = board.version
    return board
  }
  return {
    read: async () => (await refreshed(await server.read())).run,
    async write(change) {
      for (let attempt = 0; attempt < TRIES; attempt++) {
        const board = await server.read()
        const next = change(board.run)
        if (sameRun(next, board.run)) {
          await refreshed(board)
          return next
        }
        const done = await server.commit(next, board.version)
        if (done === 'committed') {
          await refreshed({ ...board, run: next, version: board.version + 1 })
          return next
        }
        if (done !== 'stale') throw new Error(REFUSED[done])
      }
      throw new Error(`meld: the board is busy: another write came first ${TRIES} times`)
    },
  }
}

/** Whether two runs hold the same values, as the JSON of a board gives them. */
export function sameRun(one: Run | null, other: Run | null): boolean {
  return JSON.stringify(one) === JSON.stringify(other)
}
