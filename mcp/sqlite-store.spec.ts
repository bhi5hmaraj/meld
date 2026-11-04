import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import { startRun } from '../core/board'
import type { Run } from '../types'
import { STORE_CHECKS } from '../tests/store-conformance'
import { LEASE_MS, SCHEMA_VERSION, SqliteBoards } from './sqlite-store'

const HEAD = 'abc1234def5678abc1234def5678abc1234def56'
const NOW = 1_800_000_000_000
const WRITER = join(import.meta.dir, 'writer.spec-helper.ts')
const WRITES = 40

function newRun(): Run {
  const workers = [{ id: 'w1' as const, path: '/tmp/meld/r1/w1', ref: 'meld/r1/w1', agent: { type: 'meld:worker' } }]
  return startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers })
}

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'meld-db-')), 'meld.db')
}

for (const [name, check] of STORE_CHECKS) test(`the SQLite store: ${name}`, () => check(new SqliteBoards(':memory:').board('b1')))

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
