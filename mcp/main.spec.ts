import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { startRun } from '../core/board'
import type { Run } from '../types'
import { Client } from './client.spec-helper'
import { RETENTION_MS, SqliteBoards } from './sqlite-store'

const HEAD = 'abc1234def5678abc1234def5678abc1234def56'
const STUB_AGENT = join(import.meta.dir, 'stub-agent.spec-helper.ts')
const NOW = 1_800_000_000_000
const TOOLS = ['read_board', 'commit_board', 'list_boards', 'run_records', 'adopt_board', 'board_channel', 'lead_board', 'spawn_worker', 'send_worker', 'stop_worker', 'acp_agents', 'take_actions']

function newRun(): Run {
  const workers = [{ id: 'w1' as const, path: '/tmp/meld/r1/w1', ref: 'meld/r1/w1', agent: { type: 'meld:worker' } }]
  return startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers })
}

const folders: string[] = []

/** Whether a process with the marker in its command line runs. */
function running(marker: string): boolean {
  return Bun.spawnSync(['pgrep', '-f', marker]).exitCode === 0
}

function tempDb(): string {
  const folder = mkdtempSync(join(tmpdir(), 'meld-mcp-'))
  folders.push(folder)
  return join(folder, 'meld.db')
}

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

test('meld mcp answers initialize with its name and the tools capability, and lists its board tools, the reads marked as reads', async () => {
  const client = new Client(tempDb())
  const started = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  expect(started.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'meld' } })
  client.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const listed = await client.request('tools/list')
  const tools = listed.result?.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[]
  expect(tools.map(tool => tool.name)).toEqual(TOOLS)
  expect(tools.filter(tool => tool.annotations?.readOnlyHint).map(tool => tool.name)).toEqual(['read_board', 'list_boards', 'run_records', 'board_channel', 'acp_agents'])
  expect(await client.end()).toBe(0)
})

test('meld mcp speaks the version of the protocol that Claude Code 2.1.318 asks for, and its newest version for an unknown one', async () => {
  const client = new Client(tempDb())
  expect((await client.request('initialize', { protocolVersion: '2025-11-25' })).result?.protocolVersion).toBe('2025-11-25')
  expect((await client.request('initialize', { protocolVersion: '2099-01-01' })).result?.protocolVersion).toBe('2025-11-25')
  await client.end()
})

test('run_records gives the record of each run that the file keeps', async () => {
  const client = new Client(tempDb())
  await client.call('commit_board', { board: 'b1', run: newRun(), version: 0, owner: 's1' })
  const { runs } = (await client.call('run_records', {})) as { runs: { id: string; board: string; state: string; workers: string[] }[] }
  expect(runs.map(record => [record.id, record.board, record.state, record.workers])).toEqual([['r1', 'b1', 'starting', ['w1']]])
  await client.end()
})

test('at its start, meld mcp removes a board that changed more than 30 days ago and holds no run', async () => {
  const db = tempDb()
  const boards = new SqliteBoards(db)
  boards.commit('old', null, 0, 's1', Date.now() - RETENTION_MS - 60_000)
  boards.commit('new', null, 0, 's1', Date.now())
  boards.close()
  const client = new Client(db)
  expect(await client.call('read_board', { board: 'old' })).toMatchObject({ version: 0 })
  expect(await client.call('read_board', { board: 'new' })).toMatchObject({ version: 1 })
  await client.end()
})

test('at its start, meld mcp makes the backup of the day next to the board file', async () => {
  const db = tempDb()
  const client = new Client(db)
  await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  expect(readdirSync(join(dirname(db), 'backups'))).toEqual([`meld-${new Date().toISOString().slice(0, 10)}.db`])
  await client.end()
})

test('a commit through the tools keeps the run in the file for the next process', async () => {
  const db = tempDb()
  const first = new Client(db)
  expect(await first.call('commit_board', { board: 'b1', run: newRun(), version: 0, owner: 's1' })).toEqual({ result: 'committed' })
  expect(await first.call('commit_board', { board: 'b1', run: newRun(), version: 0, owner: 's1' })).toEqual({ result: 'stale' })
  await first.end()
  const second = new Client(db)
  expect(await second.call('read_board', { board: 'b1' })).toMatchObject({ run: JSON.parse(JSON.stringify(newRun())), version: 1, owner: 's1' })
  expect(await second.call('list_boards', {})).toMatchObject({ boards: [{ board: 'b1', run: 'r1', state: 'starting' }] })
  await second.end()
})

test('meld mcp names its board channel next to its board file, the channel answers what a commit wrote, and the socket goes with the process', async () => {
  const db = tempDb()
  const client = new Client(db)
  const { socketPath } = (await client.call('board_channel', {})) as { socketPath: string }
  expect(dirname(socketPath)).toBe(join(dirname(db), 'channels'))
  await client.call('commit_board', { board: 'b1', run: newRun(), version: 0, owner: 's1' })
  expect(await (await fetch('http://meld/boards/b1', { unix: socketPath })).json()).toMatchObject({ run: { id: 'r1' }, version: 1 })
  expect(await client.end()).toBe(0)
  expect(existsSync(socketPath)).toBe(false)
})

test('meld mcp makes the folder of a new board file open to its user only', async () => {
  const db = join(dirname(tempDb()), 'new', 'meld.db')
  const client = new Client(db)
  await client.call('list_boards', {})
  expect(statSync(dirname(db)).mode & 0o777).toBe(0o700)
  expect(await client.end()).toBe(0)
})

test('SIGINT, which Claude Code sends at the end of a session, stops the ACP agents of meld mcp and removes its socket', async () => {
  const db = tempDb()
  const marker = `meld-sigint-${process.pid}`
  const client = new Client(db, [], { MELD_ACP_AGENTS: JSON.stringify({ stub: ['bun', STUB_AGENT, marker] }) })
  const { socketPath } = (await client.call('board_channel', {})) as { socketPath: string }
  const spawned = await client.call('spawn_worker', { board: 'b1', subagentType: 'acp:stub', cwd: dirname(db), prompt: 'Go', description: 'meld w1' })
  expect(spawned).toMatchObject({ agentId: expect.stringMatching(/^acp-/) })
  expect(running(marker)).toBe(true)
  await client.signal('SIGINT')
  expect(existsSync(socketPath)).toBe(false)
  expect(running(marker)).toBe(false)
})

test('an adopt waits for the lease of the owner, and a resume after it takes the board', async () => {
  const client = new Client(tempDb())
  await client.call('commit_board', { board: 'b1', run: newRun(), version: 0, owner: 's1' })
  expect(await client.call('adopt_board', { board: 'b1', owner: 's2' })).toMatchObject({ result: 'busy', owner: 's1' })
  expect(await client.call('adopt_board', { board: 'b9', owner: 's2' })).toEqual({ result: 'missing' })
  await client.end()
})

test('a call with a wrong argument, and an unknown tool, give an error result; an unknown method gives a JSON-RPC error', async () => {
  const client = new Client(tempDb())
  const wrong = await client.request('tools/call', { name: 'commit_board', arguments: { board: 'b1', run: null, version: 'one', owner: 's1' } })
  expect(wrong.result?.isError).toBe(true)
  expect(wrong.result?.content?.[0]?.text).toContain('version')
  const unknown = await client.request('tools/call', { name: 'nothing', arguments: {} })
  expect(unknown.result?.isError).toBe(true)
  expect((await client.request('resources/list')).error?.code).toBe(-32601)
  await client.end()
})

test('a line that is not JSON gets a parse error, and the server goes on', async () => {
  const client = new Client(tempDb())
  client.send('not json')
  expect((await client.replyTo(null)).error?.code).toBe(-32700)
  expect((await client.request('ping')).result).toEqual({})
  expect(await client.end()).toBe(0)
})
