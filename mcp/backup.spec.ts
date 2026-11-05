import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Database } from 'bun:sqlite'

import { startRun } from '../core/board'
import type { Run } from '../types'
import { BACKUPS_KEPT, backUp } from './backup'
import { SqliteBoards } from './sqlite-store'

const HEAD = 'abc1234def5678abc1234def5678abc1234def56'
const NOW = 1_800_000_000_000
const TODAY = 'meld-2027-01-15.db'
/** A process id above the largest that Linux gives, so no process has it. */
const ENDED_PID = 4_194_305
const OWNER_ONLY = 0o600
const PRIVATE_FOLDER = 0o700

const folders: string[] = []

function tempDb(): string {
  const folder = mkdtempSync(join(tmpdir(), 'meld-backup-'))
  folders.push(folder)
  return join(folder, 'meld.db')
}

function backupsOf(db: string): string {
  return join(dirname(db), 'backups')
}

function newRun(): Run {
  const workers = [{ id: 'w1' as const, path: '/tmp/meld/r1/w1', ref: 'meld/r1/w1', agent: { type: 'meld:worker' } }]
  return startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers })
}

function boardIds(copy: string): string[] {
  const db = new Database(copy, { readonly: true })
  const ids = (db.query('SELECT id FROM boards ORDER BY id').all() as { id: string }[]).map(row => row.id)
  db.close()
  return ids
}

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

test('a backup copies the board file to backups/meld-<date>.db, in a folder that only its user opens', () => {
  const db = tempDb()
  const boards = new SqliteBoards(db)
  boards.commit('b1', newRun(), 0, 's1', NOW)
  expect(backUp(boards, NOW)).toBe(join(backupsOf(db), TODAY))
  expect(boardIds(join(backupsOf(db), TODAY))).toEqual(['b1'])
  expect(statSync(backupsOf(db)).mode & 0o777).toBe(PRIVATE_FOLDER)
  expect(statSync(join(backupsOf(db), TODAY)).mode & 0o777).toBe(OWNER_ONLY)
})

test('a second backup on the same day copies nothing', () => {
  const db = tempDb()
  const boards = new SqliteBoards(db)
  backUp(boards, NOW)
  boards.commit('b1', newRun(), 0, 's1', NOW)
  expect(backUp(boards, NOW + 60_000)).toBeUndefined()
  expect(boardIds(join(backupsOf(db), TODAY))).toEqual([])
})

test(`only the ${BACKUPS_KEPT} newest backups stay, and other files of the folder stay too`, () => {
  const db = tempDb()
  mkdirSync(backupsOf(db))
  for (const day of [1, 2, 3, 4, 5, 6]) writeFileSync(join(backupsOf(db), `meld-2027-01-0${day}.db`), '')
  writeFileSync(join(backupsOf(db), 'notes.txt'), 'mine')
  backUp(new SqliteBoards(db), NOW)
  expect(readdirSync(backupsOf(db)).sort()).toEqual(['meld-2027-01-03.db', 'meld-2027-01-04.db', 'meld-2027-01-05.db', 'meld-2027-01-06.db', TODAY, 'notes.txt'])
})

test('a backup removes the part file of a process that ended during its copy, and keeps the part file of a live process', () => {
  const db = tempDb()
  mkdirSync(backupsOf(db))
  writeFileSync(join(backupsOf(db), `${TODAY}.part-${ENDED_PID}`), 'half a copy')
  writeFileSync(join(backupsOf(db), `meld-2027-01-14.db.part-${process.pid}`), 'a copy at work')
  backUp(new SqliteBoards(db), NOW, ENDED_PID + 1)
  expect(readdirSync(backupsOf(db)).sort()).toEqual([`meld-2027-01-14.db.part-${process.pid}`, TODAY])
})

test('a copy that fails leaves no part file and no backup', () => {
  const db = tempDb()
  const boards = new SqliteBoards(db)
  boards.close()
  expect(() => backUp(boards, NOW)).toThrow()
  expect(readdirSync(backupsOf(db))).toEqual([])
})
