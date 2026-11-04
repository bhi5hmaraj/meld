import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startRun } from '../core/board'
import type { Run } from '../types'

const MAIN = join(import.meta.dir, 'main.ts')
const HEAD = 'abc1234def5678abc1234def5678abc1234def56'
const NOW = 1_800_000_000_000
const TOOLS = ['read_board', 'commit_board', 'write_facts', 'list_boards', 'adopt_board']

type Reply = { id: number | null; result?: { content?: { type: string; text: string }[]; isError?: boolean; [field: string]: unknown }; error?: { code: number; message: string } }

/** A client of meld mcp over its standard input and output, one JSON-RPC message on each line. */
class Client {
  private readonly server: Bun.Subprocess<'pipe', 'pipe', 'pipe'>
  private readonly replies: Reply[] = []
  private nextId = 1

  constructor(db: string) {
    this.server = Bun.spawn(['bun', MAIN], { env: { ...process.env, MELD_DB: db }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    void this.collect()
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<Reply> {
    const id = this.nextId++
    this.send({ jsonrpc: '2.0', id, method, params })
    return this.replyTo(id)
  }

  send(message: object | string): void {
    this.server.stdin.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`)
    void this.server.stdin.flush()
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const reply = await this.request('tools/call', { name, arguments: args })
    return JSON.parse(reply.result?.content?.[0]?.text ?? 'null')
  }

  async replyTo(id: number | null): Promise<Reply> {
    for (let wait = 0; wait < 200; wait++) {
      const found = this.replies.find(reply => reply.id === id)
      if (found) return found
      await Bun.sleep(10)
    }
    throw new Error(`no reply to ${id}`)
  }

  async end(): Promise<number> {
    this.server.stdin.end()
    return this.server.exited
  }

  private async collect(): Promise<void> {
    let buffer = ''
    for await (const chunk of this.server.stdout) {
      buffer += new TextDecoder().decode(chunk)
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) this.replies.push(JSON.parse(line) as Reply)
    }
  }
}

function newRun(): Run {
  const workers = [{ id: 'w1' as const, path: '/tmp/meld/r1/w1', ref: 'meld/r1/w1', agent: { type: 'meld:worker' } }]
  return startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers })
}

const folders: string[] = []

function tempDb(): string {
  const folder = mkdtempSync(join(tmpdir(), 'meld-mcp-'))
  folders.push(folder)
  return join(folder, 'meld.db')
}

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

test('meld mcp answers initialize with its name and the tools capability, and lists its board tools', async () => {
  const client = new Client(tempDb())
  const started = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  expect(started.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'meld' } })
  client.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const listed = await client.request('tools/list')
  expect((listed.result?.tools as { name: string }[]).map(tool => tool.name)).toEqual(TOOLS)
  expect(await client.end()).toBe(0)
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
