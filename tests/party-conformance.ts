import { startRun } from '../core/board'
import { LOCAL_PARTY, MEMBER_LEASE_MS } from '../core/party'
import type { Member, Members, PartyRows } from '../core/party'
import type { ContextEntry, Entry, Run } from '../types'

/**
 * What every store of a party must do, in SQLite and later in Postgres: the log and context entries of its runs are rows
 * that are only added, and its members hold a lease. The checks throw, and import no test runner.
 */

const HEAD = 'abc1234def5678abc1234def5678abc1234def56'
const NOW = 1_800_000_000_000
const MEMBER: Member = { party: LOCAL_PARTY, id: 'session-1', kind: 'claude-code', slots: 3, seenAt: NOW }

function event(id: number): Entry {
  return { id, at: NOW + id, by: 'w1', kind: 'note', text: `note ${id}` }
}

function fact(id: number, text = `fact ${id}`): ContextEntry {
  return { id, at: NOW + id, kind: 'fact', by: 'w1', text, files: [], seenBy: [] }
}

function runWith(id: string, log: number[], context: number[]): Run {
  const workers = [{ id: 'w1' as const, path: `/tmp/meld/${id}/w1`, ref: `meld/${id}/w1`, agent: { type: 'meld:worker' } }]
  const run = startRun({ id, request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers })
  return { ...run, log: log.map(event), context: context.map(entry => fact(entry)) }
}

function same(actual: unknown, expected: unknown, what: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what} is ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}`)
}

function ids(rows: readonly { id: number }[]): number[] {
  return rows.map(row => row.id)
}

async function rowsOfARun(rows: PartyRows): Promise<void> {
  await rows.addRun(LOCAL_PARTY, runWith('r1', [1, 2], [1]))
  same(await rows.events('r1'), [1, 2].map(id => ({ run: 'r1', id, party: LOCAL_PARTY, entry: event(id) })), 'the events of the run')
  const { seenBy, ...entry } = fact(1)
  same(seenBy, [], 'the readers of a new entry')
  same(await rows.context(LOCAL_PARTY), [{ run: 'r1', id: 1, party: LOCAL_PARTY, entry, uploaded: false }], 'the context of the party')
}

async function repeatedAddChangesNothing(rows: PartyRows): Promise<void> {
  const run = runWith('r1', [1, 2], [1])
  await rows.addRun(LOCAL_PARTY, run)
  await rows.addRun(LOCAL_PARTY, run)
  same(ids(await rows.events('r1')), [1, 2], 'the events after a repeated add')
  same(ids(await rows.context(LOCAL_PARTY)), [1], 'the context after a repeated add')
}

async function trimmedEntriesStay(rows: PartyRows): Promise<void> {
  await rows.addRun(LOCAL_PARTY, runWith('r1', [1, 2, 3], [1, 2]))
  await rows.addRun(LOCAL_PARTY, runWith('r1', [3, 4], [2, 3]))
  same(ids(await rows.events('r1')), [1, 2, 3, 4], 'the events after the run trimmed its log')
  same(ids(await rows.context(LOCAL_PARTY)), [1, 2, 3], 'the context after the run trimmed its entries')
}

async function firstWriteStays(rows: PartyRows): Promise<void> {
  await rows.addRun(LOCAL_PARTY, runWith('r1', [], [1]))
  await rows.addRun(LOCAL_PARTY, { ...runWith('r1', [], []), context: [{ ...fact(1, 'another text'), seenBy: ['w2'] }] })
  same((await rows.context(LOCAL_PARTY)).map(row => row.entry.text), ['fact 1'], 'the text after a later add of the same entry')
}

async function partiesStandApart(rows: PartyRows): Promise<void> {
  await rows.addRun(LOCAL_PARTY, runWith('r1', [1], [1]))
  await rows.addRun('p2', runWith('r2', [1], [1, 2]))
  same((await rows.context(LOCAL_PARTY)).map(row => row.run), ['r1'], 'the runs of the context of the local party')
  same((await rows.context('p2')).map(row => row.run), ['r2', 'r2'], 'the runs of the context of party p2')
  same(ids(await rows.events('r2')), [1], 'the events of a run of party p2')
}

async function outboxUntilUploaded(rows: PartyRows): Promise<void> {
  await rows.addRun(LOCAL_PARTY, runWith('r1', [], [1, 2]))
  same(ids(await rows.outbox(LOCAL_PARTY)), [1, 2], 'the outbox before an upload')
  await rows.markUploaded([{ run: 'r1', id: 1 }])
  same(ids(await rows.outbox(LOCAL_PARTY)), [2], 'the outbox after the upload of entry 1')
  await rows.addRun(LOCAL_PARTY, runWith('r1', [], [1, 2]))
  same(ids(await rows.outbox(LOCAL_PARTY)), [2], 'the outbox after the run came again')
  same((await rows.context(LOCAL_PARTY)).map(row => row.uploaded), [true, false], 'the upload marks of the context')
}

async function liveWithinTheLease(members: Members): Promise<void> {
  await members.join(MEMBER)
  same(await members.members(LOCAL_PARTY, NOW + MEMBER_LEASE_MS - 1), [MEMBER], 'the members within the lease')
  same(await members.members(LOCAL_PARTY, NOW + MEMBER_LEASE_MS), [], 'the members at the end of the lease')
  const renewed = { ...MEMBER, slots: 2, seenAt: NOW + MEMBER_LEASE_MS }
  await members.join(renewed)
  same(await members.members(LOCAL_PARTY, NOW + MEMBER_LEASE_MS), [renewed], 'the members after a join that renews the lease')
}

async function leaveEndsAMember(members: Members): Promise<void> {
  await members.join(MEMBER)
  await members.join({ ...MEMBER, id: 'codex-1', kind: 'codex', slots: 1 })
  await members.leave(LOCAL_PARTY, MEMBER.id)
  same((await members.members(LOCAL_PARTY, NOW)).map(member => member.id), ['codex-1'], 'the members after a leave')
}

async function membersStandApart(members: Members): Promise<void> {
  await members.join(MEMBER)
  await members.join({ ...MEMBER, party: 'p2' })
  await members.leave('p2', MEMBER.id)
  same(await members.members(LOCAL_PARTY, NOW), [MEMBER], 'the members of the local party after a leave of party p2')
}

export const ROW_CHECKS: [string, (rows: PartyRows) => Promise<void>][] = [
  ['the rows of a run are its log entries and its context entries', rowsOfARun],
  ['a repeated add of a run changes nothing', repeatedAddChangesNothing],
  ['rows are only added: entries that the run trimmed stay', trimmedEntriesStay],
  ['the first write of an entry stays', firstWriteStays],
  ['the rows of two parties stand apart', partiesStandApart],
  ['the outbox gives the context entries until they are uploaded', outboxUntilUploaded],
]

export const MEMBER_CHECKS: [string, (members: Members) => Promise<void>][] = [
  ['a member is live within its lease, and a join renews it', liveWithinTheLease],
  ['a member that leaves is gone, and the others stay', leaveEndsAMember],
  ['the members of two parties stand apart', membersStandApart],
]
