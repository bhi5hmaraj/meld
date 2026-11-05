import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import { startRun } from '../core/board'
import { LOCAL_PARTY } from '../core/party'
import type { ContextEntry, Entry, Run } from '../types'
import { MEMBER_CHECKS, ROW_CHECKS } from '../tests/party-conformance'
import { STORE_CHECKS } from '../tests/store-conformance'
import { LEASE_MS, SCHEMA_VERSION, SqliteBoards } from './sqlite-store'

const HEAD = 'abc1234def5678abc1234def5678abc1234def56'
const NOW = 1_800_000_000_000
const WRITER = join(import.meta.dir, 'writer.spec-helper.ts')
const WRITES = 40
const OWNER_ONLY = 0o600
const WORLD_READABLE = 0o644

function newRun(): Run {
  const workers = [{ id: 'w1' as const, path: '/tmp/meld/r1/w1', ref: 'meld/r1/w1', agent: { type: 'meld:worker' } }]
  return startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers })
}

function note(id: number): Entry {
  return { id, at: NOW + id, by: 'w1', kind: 'note', text: `note ${id}` }
}

function fact(id: number): ContextEntry {
  return { id, at: NOW + id, kind: 'fact', by: 'w1', text: `fact ${id}`, files: [], seenBy: [] }
}

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'meld-db-')), 'meld.db')
}

for (const [name, check] of STORE_CHECKS) test(`the SQLite store: ${name}`, () => check(new SqliteBoards(':memory:').board('b1')))
for (const [name, check] of ROW_CHECKS) test(`the SQLite party store: ${name}`, () => check(new SqliteBoards(':memory:').partyStore()))
for (const [name, check] of MEMBER_CHECKS) test(`the SQLite party store: ${name}`, () => check(new SqliteBoards(':memory:').partyStore()))

test('only its user reads the board file and its write-ahead log, also a file that was open to others', () => {
  const path = tempFile()
  writeFileSync(path, '')
  chmodSync(path, WORLD_READABLE)
  const boards = new SqliteBoards(path)
  boards.commit('b1', newRun(), 0, 's1', NOW)
  expect(statSync(path).mode & 0o777).toBe(OWNER_ONLY)
  expect(statSync(`${path}-wal`).mode & 0o777).toBe(OWNER_ONLY)
  boards.close()
})

test('each commit keeps the log entries of the run as rows of the local party, also after the run trims them', async () => {
  const boards = new SqliteBoards(':memory:')
  expect(boards.commit('b1', { ...newRun(), log: [note(1), note(2)] }, 0, 's1', NOW)).toBe('committed')
  expect(boards.commit('b1', { ...newRun(), log: [note(2), note(3)] }, 1, 's1', NOW)).toBe('committed')
  const events = await boards.partyStore().events('r1')
  expect(events.map(row => [row.id, row.party])).toEqual([
    [1, LOCAL_PARTY],
    [2, LOCAL_PARTY],
    [3, LOCAL_PARTY],
  ])
})

test('a write through the Store port keeps the context entries of the run as rows too', async () => {
  const boards = new SqliteBoards(':memory:')
  await boards.board('b1').write(() => ({ ...newRun(), context: [fact(1)] }))
  expect((await boards.partyStore().context(LOCAL_PARTY)).map(row => row.id)).toEqual([1])
})

test('an action for the leader of a board is taken once, oldest first, by the runner that reaches its agent', () => {
  const boards = new SqliteBoards(':memory:')
  boards.addAction({ board: 'b1', kind: 'send', agent: 'agent-2', text: 'one', at: NOW })
  boards.addAction({ board: 'b1', kind: 'send', agent: 'acp-3', text: 'to codex', at: NOW + 1 })
  boards.addAction({ board: 'b1', kind: 'toast', agent: '', text: 'two', at: NOW + 2 })
  boards.addAction({ board: 'b2', kind: 'send', agent: 'agent-3', text: 'other', at: NOW })
  expect(boards.takeActions('b1', 'engine').map(action => action.text)).toEqual(['one', 'two'])
  expect(boards.takeActions('b1', 'engine')).toEqual([])
  expect(boards.takeActions('b1', 'acp')).toEqual([{ id: 2, board: 'b1', kind: 'send', agent: 'acp-3', text: 'to codex', at: NOW + 1 }])
  expect(boards.takeActions('b2', 'engine').map(action => action.text)).toEqual(['other'])
})

test('a new file holds the local party of the machine', () => {
  const boards = new SqliteBoards(':memory:', NOW)
  expect(boards.parties()).toEqual([{ id: LOCAL_PARTY, name: 'local', leader: null, host: 'meld mcp', policies: {}, createdAt: NOW }])
})

test('a file of schema 1 gets the tables of schema 2, and its boards stay, in the local party', async () => {
  const path = tempFile()
  const old = new Database(path)
  old.exec('CREATE TABLE boards (id TEXT PRIMARY KEY, run TEXT, version INTEGER NOT NULL DEFAULT 0, owner TEXT, owner_at INTEGER)')
  old.query('INSERT INTO boards (id, run, version, owner, owner_at) VALUES (?, ?, ?, ?, ?)').run('b1', JSON.stringify(newRun()), 3, 's1', NOW)
  old.exec('PRAGMA user_version = 1')
  old.close()
  const boards = new SqliteBoards(path, NOW)
  expect(boards.read('b1')).toEqual({ run: newRun(), version: 3, owner: 's1', ownerAt: NOW })
  expect(boards.commit('b1', { ...newRun(), log: [note(1)] }, 3, 's1', NOW)).toBe('committed')
  expect((await boards.partyStore().events('r1')).map(row => row.party)).toEqual([LOCAL_PARTY])
  boards.close()
  expect((new Database(path).query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
  rmSync(path, { force: true })
})

test('a second open of a file changes nothing of its schema', () => {
  const path = tempFile()
  new SqliteBoards(path, NOW).close()
  const again = new SqliteBoards(path, NOW + 1)
  expect(again.parties().map(party => party.createdAt)).toEqual([NOW])
  again.close()
  rmSync(path, { force: true })
})

test('two boards of one file stand apart', async () => {
  const boards = new SqliteBoards(':memory:')
  await boards.board('b1').write(newRun)
  expect(await boards.board('b2').read()).toBeNull()
})

test('a file keeps the board for the next process, in WAL mode', async () => {
  const path = tempFile()
  await new SqliteBoards(path).board('b1').write(newRun)
  expect(await new SqliteBoards(path).board('b1').read()).toEqual(newRun())
  expect(new Database(path).query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
  rmSync(path, { force: true })
})

test('a commit names the version that it read: a commit after another one is stale, and stores nothing', () => {
  const boards = new SqliteBoards(':memory:')
  expect(boards.read('b1')).toEqual({ run: null, version: 0, owner: null, ownerAt: null })
  expect(boards.commit('b1', newRun(), 0, 's1', NOW)).toBe('committed')
  expect(boards.commit('b1', { ...newRun(), revision: 9 }, 0, 's1', NOW)).toBe('stale')
  expect(boards.read('b1')).toEqual({ run: newRun(), version: 1, owner: 's1', ownerAt: NOW })
})

test('a session adopts a board only when its owner wrote nothing for the time of a lease', () => {
  const boards = new SqliteBoards(':memory:')
  boards.commit('b1', newRun(), 0, 's1', NOW)
  expect(boards.adopt('b1', 's2', NOW + LEASE_MS - 1)).toEqual({ owner: 's1', ownerAt: NOW })
  expect(boards.adopt('b1', 's2', NOW + LEASE_MS)).toBe('adopted')
  expect(boards.read('b1')).toMatchObject({ owner: 's2', ownerAt: NOW + LEASE_MS })
  expect(boards.adopt('b9', 's2', NOW)).toBe('missing')
})

test('a commit of another session while the owner holds its lease is refused, and an adopt makes the commits of the old owner stale', () => {
  const boards = new SqliteBoards(':memory:')
  boards.commit('b1', newRun(), 0, 's1', NOW)
  expect(boards.commit('b1', newRun(), 1, 's2', NOW + 1)).toBe('taken')
  expect(boards.adopt('b1', 's2', NOW + LEASE_MS)).toBe('adopted')
  expect(boards.commit('b1', newRun(), 1, 's1', NOW + LEASE_MS + 1)).toBe('stale')
  expect(boards.commit('b1', newRun(), 2, 's1', NOW + LEASE_MS + 1)).toBe('taken')
  expect(boards.commit('b1', newRun(), 2, 's2', NOW + LEASE_MS + 1)).toBe('committed')
})

test('the list gives each board with a run: its run, state and request, its owner, and when it changed', () => {
  const boards = new SqliteBoards(':memory:')
  boards.commit('b1', newRun(), 0, 's1', NOW)
  boards.commit('b2', null, 0, 's2', NOW)
  expect(boards.list()).toEqual([{ board: 'b1', run: 'r1', state: 'starting', request: 'Add a dark theme', repo: '/repo', owner: 's1', ownerAt: NOW }])
})

test('two processes that write one board at one time lose no write', async () => {
  const path = tempFile()
  await new SqliteBoards(path).board('b1').write(newRun)
  const writers = [1, 2].map(() => Bun.spawn(['bun', WRITER, path, String(WRITES)], { stderr: 'pipe' }))
  const codes = await Promise.all(writers.map(writer => writer.exited))
  expect(codes).toEqual([0, 0])
  expect((await new SqliteBoards(path).board('b1').read())?.revision).toBe(newRun().revision + 2 * WRITES)
  rmSync(path, { force: true })
})

test('a file of a newer schema refuses each write, so an old meld does not damage it', async () => {
  const path = tempFile()
  new SqliteBoards(path).close()
  new Database(path).exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
  const boards = new SqliteBoards(path)
  expect(await boards.board('b1').write(newRun).then(() => 'stored', (error: unknown) => String(error))).toContain('a newer meld')
  expect(boards.commit('b1', newRun(), 0, 's1', NOW)).toBe('newer schema')
  rmSync(path, { force: true })
})
