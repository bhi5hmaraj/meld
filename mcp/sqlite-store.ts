import { Database } from 'bun:sqlite'
import { chmodSync, existsSync, writeFileSync } from 'node:fs'

import { ACP_AGENT_PREFIX } from '../core/options'
import { LOCAL_PARTY, MEMBER_LEASE_MS, rowsOf } from '../core/party'
import type { ContextRow, EventRow, Member, Members, Party, PartyRows, RowKey } from '../core/party'
import type { Store } from '../core/ports'
import type { Action, Adopted, BoardRead, BoardSummary, Committed } from '../core/remote-store'
import type { Run } from '../types'

/** The version of the tables in the file. A meld that knows only an older version reads the file and writes nothing. */
export const SCHEMA_VERSION = 3
/** How long the owner of a board holds it with no write. After that, another session can adopt the board, as a resume does. */
export const LEASE_MS = 60_000
/** How long a write waits for the write lock that another process holds. */
const BUSY_MS = 5000
const MEMORY = ':memory:'
/** The board file holds the runs of every session on the machine, so only its user reads it. */
const OWNER_ONLY = 0o600
const NEWER = 'a newer meld wrote this board file: restart the session, so it loads the newer meld'

/** A board as a client reads it, with the session that owns it. */
export type BoardRow = BoardRead & { owner: string | null; ownerAt: number | null }

type Row = { id: string; run: string | null; version: number; owner: string | null; owner_at: number | null; party: string }
type PartyRow = { id: string; name: string; leader: string | null; host: string; policies: string; created_at: number }
type EntryRow = { run: string; id: number; party: string; entry: string; uploaded?: number }
type MemberRow = { party: string; id: string; kind: string; slots: number; seen_at: number }

/** The steps that bring a file to SCHEMA_VERSION: the step at index N moves a file from version N to version N + 1. */
const MIGRATIONS: ((db: Database, now: number) => void)[] = [
  db =>
    db.exec(`CREATE TABLE boards (
      id TEXT PRIMARY KEY,
      run TEXT,
      version INTEGER NOT NULL DEFAULT 0,
      owner TEXT,
      owner_at INTEGER
    )`),
  (db, now) => {
    db.exec(`CREATE TABLE parties (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      leader TEXT,
      host TEXT NOT NULL,
      policies TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    )`)
    db.query('INSERT INTO parties (id, name, host, created_at) VALUES (?, ?, ?, ?)').run(LOCAL_PARTY, LOCAL_PARTY, 'meld mcp', now)
    db.exec(`ALTER TABLE boards ADD COLUMN party TEXT NOT NULL DEFAULT '${LOCAL_PARTY}'`)
    db.exec(`CREATE TABLE members (
      party TEXT NOT NULL,
      id TEXT NOT NULL,
      kind TEXT NOT NULL,
      slots INTEGER NOT NULL,
      seen_at INTEGER NOT NULL,
      PRIMARY KEY (party, id)
    )`)
    db.exec(`CREATE TABLE events (
      run TEXT NOT NULL,
      id INTEGER NOT NULL,
      party TEXT NOT NULL,
      at INTEGER NOT NULL,
      entry TEXT NOT NULL,
      PRIMARY KEY (run, id)
    )`)
    db.exec(`CREATE TABLE context (
      run TEXT NOT NULL,
      id INTEGER NOT NULL,
      party TEXT NOT NULL,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      entry TEXT NOT NULL,
      uploaded INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run, id)
    )`)
    db.exec('CREATE INDEX context_of_party ON context (party, uploaded, at)')
  },
  db =>
    db.exec(`CREATE TABLE actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board TEXT NOT NULL,
      kind TEXT NOT NULL,
      agent TEXT NOT NULL,
      text TEXT NOT NULL,
      at INTEGER NOT NULL
    )`),
]

/**
 * The boards of every session on the machine, in one SQLite file in WAL mode, with the parties, their members, and the
 * events and context entries of their runs. Each session keeps its run on one board. Each write is one transaction
 * that takes the write lock first, so two processes that write one board lose no write.
 */
export class SqliteBoards {
  private readonly db: Database
  private readonly newer: boolean

  /** `now` is the time that a new file records for its local party. */
  constructor(
    readonly path: string,
    now = Date.now(),
  ) {
    if (path !== MEMORY) keepPrivate(path)
    this.db = new Database(path, { create: true })
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_MS}`)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.newer = this.migrate(now)
  }

  /** The Store port for one board, for the logic that runs in this process. */
  board(id: string): Store {
    return {
      read: async () => this.read(id).run,
      write: async change => this.change(id, change),
    }
  }

  /** The PartyRows and Members ports over this file, for the logic that runs in this process. */
  partyStore(): PartyRows & Members {
    return {
      addRun: async (party, run) => this.addRun(party, run),
      events: async run => this.events(run),
      context: async party => this.context(party, false),
      outbox: async party => this.context(party, true),
      markUploaded: async keys => this.markUploaded(keys),
      join: async member => this.join(member),
      members: async (party, now) => this.members(party, now),
      leave: async (party, id) => this.leave(party, id),
    }
  }

  read(id: string): BoardRow {
    const row = this.row(id)
    return { run: parsed(row?.run), version: row?.version ?? 0, owner: row?.owner ?? null, ownerAt: row?.owner_at ?? null }
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
        this.put(id, textOf(run), version + 1, owner, now)
        if (run) this.addRows(row?.party ?? LOCAL_PARTY, run)
        return 'committed'
      })
      .immediate()
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

  parties(): Party[] {
    const rows = this.db.query('SELECT id, name, leader, host, policies, created_at FROM parties ORDER BY created_at, id').all() as PartyRow[]
    return rows.map(row => ({ id: row.id, name: row.name, leader: row.leader, host: row.host, policies: JSON.parse(row.policies) as Record<string, unknown>, createdAt: row.created_at }))
  }

  /** Adds each entry of the run that the file does not hold, in one transaction. */
  addRun(party: string, run: Run): void {
    if (this.newer) throw new Error(NEWER)
    this.db.transaction(() => this.addRows(party, run)).immediate()
  }

  events(run: string): EventRow[] {
    const rows = this.db.query('SELECT run, id, party, entry FROM events WHERE run = ? ORDER BY id').all(run) as EntryRow[]
    return rows.map(row => ({ run: row.run, id: row.id, party: row.party, entry: JSON.parse(row.entry) as EventRow['entry'] }))
  }

  /** The context entries of a party, by time, then run, then entry; with `outbox`, only those not uploaded yet. */
  context(party: string, outbox: boolean): ContextRow[] {
    const filter = outbox ? 'AND uploaded = 0' : ''
    const rows = this.db.query(`SELECT run, id, party, entry, uploaded FROM context WHERE party = ? ${filter} ORDER BY at, run, id`).all(party) as EntryRow[]
    return rows.map(row => ({ run: row.run, id: row.id, party: row.party, entry: JSON.parse(row.entry) as ContextRow['entry'], uploaded: row.uploaded === 1 }))
  }

  markUploaded(keys: readonly RowKey[]): void {
    if (this.newer) throw new Error(NEWER)
    const mark = this.db.query('UPDATE context SET uploaded = 1 WHERE run = ? AND id = ?')
    this.db.transaction(() => keys.forEach(key => mark.run(key.run, key.id))).immediate()
  }

  join(member: Member): void {
    if (this.newer) throw new Error(NEWER)
    this.db
      .query(
        `INSERT INTO members (party, id, kind, slots, seen_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(party, id) DO UPDATE SET kind = excluded.kind, slots = excluded.slots, seen_at = excluded.seen_at`,
      )
      .run(member.party, member.id, member.kind, member.slots, member.seenAt)
  }

  /** The members of a party whose lease runs at `now`, by id. */
  members(party: string, now: number): Member[] {
    const rows = this.db.query('SELECT party, id, kind, slots, seen_at FROM members WHERE party = ? AND seen_at > ? ORDER BY id').all(party, now - MEMBER_LEASE_MS) as MemberRow[]
    return rows.map(row => ({ party: row.party, id: row.id, kind: row.kind, slots: row.slots, seenAt: row.seen_at }))
  }

  leave(party: string, id: string): void {
    if (this.newer) throw new Error(NEWER)
    this.db.query('DELETE FROM members WHERE party = ? AND id = ?').run(party, id)
  }

  addAction(action: Omit<Action, 'id'>): void {
    if (this.newer) throw new Error(NEWER)
    this.db.query('INSERT INTO actions (board, kind, agent, text, at) VALUES (?, ?, ?, ?, ?)').run(action.board, action.kind, action.agent, action.text, action.at)
  }

  /**
   * The actions for the leader of a board, the oldest first: for `acp`, the messages to the agents that meld mcp runs;
   * for `engine`, the rest, which the plugin carries out. The transaction holds the write lock, so each is taken once.
   */
  takeActions(board: string, target: 'acp' | 'engine'): Action[] {
    if (this.newer) throw new Error(NEWER)
    const toAcp = `kind = 'send' AND agent LIKE '${ACP_AGENT_PREFIX}%'`
    const filter = target === 'acp' ? toAcp : `NOT (${toAcp})`
    return this.db
      .transaction((): Action[] => {
        const actions = this.db.query(`SELECT id, board, kind, agent, text, at FROM actions WHERE board = ? AND ${filter} ORDER BY id`).all(board) as Action[]
        const last = actions.at(-1)?.id ?? 0
        this.db.query(`DELETE FROM actions WHERE board = ? AND ${filter} AND id <= ?`).run(board, last)
        return actions
      })
      .immediate()
  }

  /** The boards with a run, the latest write first. */
  list(): BoardSummary[] {
    const rows = this.db.query('SELECT id, run, version, owner, owner_at FROM boards WHERE run IS NOT NULL ORDER BY owner_at DESC').all() as Row[]
    return rows.map(row => {
      const run = JSON.parse(row.run ?? 'null') as Run
      return { board: row.id, run: run.id, state: run.state, request: run.request, repo: run.repo, owner: row.owner, ownerAt: row.owner_at }
    })
  }

  close(): void {
    this.db.close()
  }

  /** A change that leaves the run as it was stores nothing, so the version stays and no reader sees a new write. */
  private change(id: string, change: (run: Run | null) => Run | null): Run | null {
    if (this.newer) throw new Error(NEWER)
    return this.db
      .transaction(() => {
        const row = this.row(id)
        const next = change(parsed(row?.run))
        const text = textOf(next)
        if (text === (row?.run ?? null)) return next
        this.put(id, text, (row?.version ?? 0) + 1, row?.owner ?? null, row?.owner_at ?? null)
        if (next) this.addRows(row?.party ?? LOCAL_PARTY, next)
        return next
      })
      .immediate()
  }

  private row(id: string): Row | null {
    return this.db.query('SELECT id, run, version, owner, owner_at, party FROM boards WHERE id = ?').get(id) as Row | null
  }

  private put(id: string, text: string | null, version: number, owner: string | null, ownerAt: number | null): void {
    this.db
      .query(
        `INSERT INTO boards (id, run, version, owner, owner_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET run = excluded.run, version = excluded.version, owner = excluded.owner, owner_at = excluded.owner_at`,
      )
      .run(id, text, version, owner, ownerAt)
  }

  /** Inserts each log and context entry of the run that the file does not hold. Call it inside a transaction. */
  private addRows(party: string, run: Run): void {
    const rows = rowsOf(party, run)
    const event = this.db.query('INSERT OR IGNORE INTO events (run, id, party, at, entry) VALUES (?, ?, ?, ?, ?)')
    for (const row of rows.events) event.run(row.run, row.id, row.party, row.entry.at, JSON.stringify(row.entry))
    const entry = this.db.query('INSERT OR IGNORE INTO context (run, id, party, at, kind, entry) VALUES (?, ?, ?, ?, ?, ?)')
    for (const row of rows.context) entry.run(row.run, row.id, row.party, row.entry.at, row.entry.kind, JSON.stringify(row.entry))
  }

  /**
   * Brings the file to SCHEMA_VERSION in one transaction that takes the write lock first, so two processes that open an
   * old file migrate it once. Says whether a newer meld wrote the file.
   */
  private migrate(now: number): boolean {
    return this.db
      .transaction((): boolean => {
        const version = (this.db.query('PRAGMA user_version').get() as { user_version: number }).user_version
        if (version > SCHEMA_VERSION) return true
        for (const step of MIGRATIONS.slice(version)) step(this.db, now)
        if (version < SCHEMA_VERSION) this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
        return false
      })
      .immediate()
  }
}

/** Another session wrote the board within the time of a lease. */
function holdsLease(row: Row, owner: string, now: number): boolean {
  return row.owner !== null && row.owner !== owner && row.owner_at !== null && now - row.owner_at < LEASE_MS
}

/** The text of a run as the boards table keeps it. */
function textOf(run: Run | null): string | null {
  return run === null ? null : JSON.stringify(run)
}

function parsed<T>(text: string | null | undefined): T | null {
  return text ? (JSON.parse(text) as T) : null
}

/** Gives the board file, its write-ahead log and its shared memory to their user only. SQLite makes a new log with the mode of the file. */
function keepPrivate(path: string): void {
  if (!existsSync(path)) writeFileSync(path, '', { mode: OWNER_ONLY })
  for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, OWNER_ONLY)
}
