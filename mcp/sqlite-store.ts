import { Database } from 'bun:sqlite'

import type { Store } from '../core/ports'
import type { Adopted, BoardRead, BoardSummary, Committed } from '../core/remote-store'
import type { Facts, Run } from '../types'

/** The version of the tables in the file. A meld that knows only an older version reads the file and writes nothing. */
export const SCHEMA_VERSION = 1
/** How long the owner of a board holds it with no write. After that, another session can adopt the board, as a resume does. */
export const LEASE_MS = 60_000
/** How long a write waits for the write lock that another process holds. */
const BUSY_MS = 5000
const NEWER = 'a newer meld wrote this board file: restart the session, so it loads the newer meld'

/** A board as a client reads it, with the session that owns it. */
export type BoardRow = BoardRead & { owner: string | null; ownerAt: number | null }

type Row = { id: string; run: string | null; facts: string | null; version: number; owner: string | null; owner_at: number | null }

/**
 * The boards of every session on the machine, in one SQLite file in WAL mode. Each session keeps its run on one board.
 * Each write is one transaction that takes the write lock first, so two processes that write one board lose no write.
 */
export class SqliteBoards {
  private readonly db: Database
  private readonly newer: boolean

  constructor(path: string) {
    this.db = new Database(path, { create: true })
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_MS}`)
    this.db.exec('PRAGMA journal_mode = WAL')
    const version = (this.db.query('PRAGMA user_version').get() as { user_version: number }).user_version
    this.newer = version > SCHEMA_VERSION
    if (version === 0) this.createTables()
  }

  /** The Store port for one board, for the logic that runs in this process. */
  board(id: string): Store {
    return {
      read: async () => this.read(id).run,
      write: async change => this.change(id, change),
      readFacts: async () => this.read(id).facts,
      writeFacts: async facts => this.writeFacts(id, facts),
    }
  }

  read(id: string): BoardRow {
    const row = this.row(id)
    return { run: parsed(row?.run), facts: parsed(row?.facts), version: row?.version ?? 0, owner: row?.owner ?? null, ownerAt: row?.owner_at ?? null }
  }

  /**
   * Stores `run` when the board is still at `version` (0 for a new board), as a client that runs the logic of meld in
   * another process writes: it read the board, made the change, and commits it. Another session that holds the lease
   * keeps the board.
   */
  commit(id: string, run: Run | null, version: number, owner: string, now: number): Committed {
    if (this.newer) return 'newer schema'
    return this.db
      .transaction((): Committed => {
        const row = this.row(id)
        if ((row?.version ?? 0) !== version) return 'stale'
        if (row && holdsLease(row, owner, now)) return 'taken'
        this.put(id, run, version + 1, owner, now)
        return 'committed'
      })
      .immediate()
  }

  writeFacts(id: string, facts: Facts | null): void {
    if (this.newer) throw new Error(NEWER)
    const text = facts === null ? null : JSON.stringify(facts)
    this.db.query('INSERT INTO boards (id, facts) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET facts = excluded.facts').run(id, text)
  }

  /**
   * The session takes a board whose owner wrote nothing for the time of a lease, as a resume in a new session does. The
   * version moves, so a commit of the old owner from its last read is stale.
   */
  adopt(id: string, owner: string, now: number): Adopted {
    return this.db
      .transaction((): Adopted => {
        const row = this.row(id)
        if (!row?.run) return 'missing'
        if (holdsLease(row, owner, now)) return { owner: row.owner ?? '', ownerAt: row.owner_at ?? 0 }
        this.db.query('UPDATE boards SET owner = ?, owner_at = ?, version = version + 1 WHERE id = ?').run(owner, now, id)
        return 'adopted'
      })
      .immediate()
  }

  /** The boards with a run, the latest write first. */
  list(): BoardSummary[] {
    const rows = this.db.query('SELECT id, run, facts, version, owner, owner_at FROM boards WHERE run IS NOT NULL ORDER BY owner_at DESC').all() as Row[]
    return rows.map(row => {
      const run = JSON.parse(row.run ?? 'null') as Run
      return { board: row.id, run: run.id, state: run.state, request: run.request, repo: run.repo, owner: row.owner, ownerAt: row.owner_at }
    })
  }

  close(): void {
    this.db.close()
  }

  private change(id: string, change: (run: Run | null) => Run | null): Run | null {
    if (this.newer) throw new Error(NEWER)
    return this.db
      .transaction(() => {
        const row = this.row(id)
        const next = change(parsed(row?.run))
        this.put(id, next, (row?.version ?? 0) + 1, row?.owner ?? null, row?.owner_at ?? null)
        return next
      })
      .immediate()
  }

  private row(id: string): Row | null {
    return this.db.query('SELECT id, run, facts, version, owner, owner_at FROM boards WHERE id = ?').get(id) as Row | null
  }

  private put(id: string, run: Run | null, version: number, owner: string | null, ownerAt: number | null): void {
    const text = run === null ? null : JSON.stringify(run)
    this.db
      .query(
        `INSERT INTO boards (id, run, version, owner, owner_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET run = excluded.run, version = excluded.version, owner = excluded.owner, owner_at = excluded.owner_at`,
      )
      .run(id, text, version, owner, ownerAt)
  }

  private createTables(): void {
    this.db
      .transaction(() => {
        this.db.exec(`CREATE TABLE IF NOT EXISTS boards (
          id TEXT PRIMARY KEY,
          run TEXT,
          facts TEXT,
          version INTEGER NOT NULL DEFAULT 0,
          owner TEXT,
          owner_at INTEGER
        )`)
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      })
      .immediate()
  }
}

/** Another session wrote the board within the time of a lease. */
function holdsLease(row: Row, owner: string, now: number): boolean {
  return row.owner !== null && row.owner !== owner && row.owner_at !== null && now - row.owner_at < LEASE_MS
}

function parsed<T>(text: string | null | undefined): T | null {
  return text ? (JSON.parse(text) as T) : null
}
