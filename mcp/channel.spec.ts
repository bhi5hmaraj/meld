import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startRun } from '../core/board'
import type { Run } from '../types'
import { BoardChannel } from './channel'
import { SqliteBoards } from './sqlite-store'

const HEAD = 'a'.repeat(40)
const NOW = 1_800_000_000_000
const ENDED_PID = 999_999_999
const PRIVATE = 0o700
const folders: string[] = []
const channels: BoardChannel[] = []

function tempFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'meld-channel-'))
  folders.push(folder)
  return folder
}

function newRun(): Run {
  const workers = [{ id: 'w1' as const, path: '/tmp/meld/r1/w1', ref: 'meld/r1/w1', agent: { type: 'acp:codex' } }]
  return startRun({ id: 'r1', request: 'Add a greeting', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers })
}

function opened(boards: SqliteBoards, folder: string): BoardChannel {
  const channel = BoardChannel.open(boards, folder)
  if (!channel) throw new Error('the channel did not open')
  channels.push(channel)
  return channel
}

afterEach(() => {
  for (const channel of channels.splice(0)) channel.stop()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

test('the channel answers a board, its version and its owner over a Unix socket, in a folder that only its user opens', async () => {
  const boards = new SqliteBoards(':memory:')
  boards.commit('b1', newRun(), 0, 's1', NOW)
  const folder = join(tempFolder(), 'channels')
  const channel = opened(boards, folder)
  const answer = await fetch('http://meld/boards/b1', { unix: channel.socketPath })
  expect(await answer.json()).toMatchObject({ run: { id: 'r1', state: 'starting' }, version: 1, owner: 's1' })
  expect(channel.socketPath).toBe(join(folder, `${process.pid}.sock`))
  expect(statSync(folder).mode & 0o777).toBe(PRIVATE)
})

test('the channel answers only reads of one board', async () => {
  const channel = opened(new SqliteBoards(':memory:'), join(tempFolder(), 'channels'))
  expect((await fetch('http://meld/boards/b1', { unix: channel.socketPath, method: 'POST', body: '{}' })).status).toBe(405)
  expect((await fetch('http://meld/boards', { unix: channel.socketPath })).status).toBe(404)
  expect((await fetch('http://meld/boards/b1/run', { unix: channel.socketPath })).status).toBe(404)
  expect(await (await fetch('http://meld/boards/b9', { unix: channel.socketPath })).json()).toMatchObject({ run: null, version: 0 })
})

test('the start removes the sockets of processes that ended, and the stop removes its own socket', () => {
  const folder = join(tempFolder(), 'channels')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, `${ENDED_PID}.sock`), '')
  writeFileSync(join(folder, `${process.pid}.sock`), '')
  writeFileSync(join(folder, 'notes.txt'), '')
  const channel = opened(new SqliteBoards(':memory:'), folder)
  expect(existsSync(join(folder, `${ENDED_PID}.sock`))).toBe(false)
  expect(existsSync(join(folder, 'notes.txt'))).toBe(true)
  channel.stop()
  expect(existsSync(channel.socketPath)).toBe(false)
})

test('a folder whose socket path is over the limit of the system gives no channel', () => {
  expect(BoardChannel.open(new SqliteBoards(':memory:'), join(tempFolder(), 'x'.repeat(120)))).toBeUndefined()
})
