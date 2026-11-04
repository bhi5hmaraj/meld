import type { ContextEntry, Entry, Run } from '../types'

/** The party of a machine: each run of `meld mcp` belongs to it, until a person makes other parties. */
export const LOCAL_PARTY = 'local'
/** How long a member stays live with no join: a runner joins again while it works. */
export const MEMBER_LEASE_MS = 60_000

/** A group of workers that staff one queue and share one context partition. A local party has no leader yet. */
export type Party = { id: string; name: string; leader: string | null; host: string; policies: Record<string, unknown>; createdAt: number }

/** The key of an entry of a run in every store: the run id and the entry id. */
export type RowKey = { run: string; id: number }
export type EventRow = RowKey & { party: string; entry: Entry }
/** A context entry as a row, without its readers, which only the run tracks; `uploaded` is its mark in the outbox. */
export type ContextRow = RowKey & { party: string; entry: Omit<ContextEntry, 'seenBy'>; uploaded: boolean }

/**
 * The rows of the parties that are only added: each log entry and each context entry of their runs. They stay after
 * the run trims them, and the outbox gives the context entries that no hosted party holds yet.
 */
export type PartyRows = {
  /** Adds each entry of the run that the store does not hold. An entry that it holds stays as first written. */
  addRun(party: string, run: Run): Promise<void>
  events(run: string): Promise<EventRow[]>
  context(party: string): Promise<ContextRow[]>
  outbox(party: string): Promise<ContextRow[]>
  markUploaded(keys: readonly RowKey[]): Promise<void>
}

/** A runner that staffs a party, such as a session or an ACP process, with its worker slots. */
export type Member = { party: string; id: string; kind: string; slots: number; seenAt: number }

export type Members = {
  /** Adds the member, or renews its lease and its slots. */
  join(member: Member): Promise<void>
  /** The members whose lease runs at `now`, by id. */
  members(party: string, now: number): Promise<Member[]>
  leave(party: string, id: string): Promise<void>
}

export function isLive(member: Member, now: number): boolean {
  return now - member.seenAt < MEMBER_LEASE_MS
}

/** The rows of a run: its log entries as events, and its context entries. */
export function rowsOf(party: string, run: Run): { events: EventRow[]; context: ContextRow[] } {
  const events = run.log.map(entry => ({ run: run.id, id: entry.id, party, entry }))
  const context = (run.context ?? []).map(({ seenBy: _readers, ...entry }) => ({ run: run.id, id: entry.id, party, entry, uploaded: false }))
  return { events, context }
}

/** The order of the context of a party in every store: by time, then by run, then by entry. */
export function contextOrder(a: ContextRow, b: ContextRow): number {
  return a.entry.at - b.entry.at || byText(a.run, b.run) || a.id - b.id
}

/** The order of text in every store: by code unit, as SQLite compares text with no collation. */
export function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
