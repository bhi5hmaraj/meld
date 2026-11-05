import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runHome } from '../core/vcs'
import { chatArgs } from './chat'
import { Client } from './client.spec-helper'
import { bunCodeHost } from './code-host'

const BOARD = 'chat-board'
const STUB_WORKER = join(import.meta.dir, 'stub-worker.spec-helper.ts')
const CHAT_TOOLS = ['add_worker', 'board', 'deliver', 'discard', 'start', 'steer', 'stop']
const RUN_MS = 30_000
const cleanups: string[] = []
const clients: Client[] = []

type Board = { id?: string; state: string; notices?: string[] }

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await bunCodeHost.run(['git', ...args], cwd)
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

/** A repository with one commit, and meld mcp in chat mode in it, with the stub worker as codex. */
async function chatIn(): Promise<{ client: Client; repo: string }> {
  const folder = mkdtempSync(join(tmpdir(), 'meld-chat-'))
  cleanups.push(folder)
  const repo = join(folder, 'repo')
  await git(folder, 'init', '-q', '-b', 'main', repo)
  await git(repo, 'config', 'user.email', 'meld@example.com')
  await git(repo, 'config', 'user.name', 'meld')
  await Bun.write(join(repo, 'README.md'), 'base\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-q', '-m', 'base')
  const env = { MELD_BOARD: BOARD, MELD_ACP_AGENTS: JSON.stringify({ codex: ['bun', STUB_WORKER] }) }
  const client = new Client(join(folder, 'meld.db'), ['--chat'], env, repo)
  clients.push(client)
  return { client, repo }
}

async function ready(client: Client): Promise<Board> {
  for (let wait = 0; wait < 100; wait++) {
    const board = (await client.call('board', {})) as Board
    if (board.state === 'ready') return board
    await Bun.sleep(200)
  }
  throw new Error('the run did not get ready')
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.end()
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true })
})

test('a start in a chat that names no agents, or only a count, gets the default ACP agent', () => {
  expect(chatArgs('start', { request: 'Go' }, 'codex')).toEqual({ request: 'Go', agents: 'codex,codex' })
  expect(chatArgs('start', { request: 'Go', agents: '3' }, 'gemini')).toEqual({ request: 'Go', agents: 'gemini,gemini,gemini' })
  expect(chatArgs('start', { request: 'Go', agents: 'codex,cursor' }, 'gemini')).toEqual({ request: 'Go', agents: 'codex,cursor' })
  expect(chatArgs('steer', { text: 'Use tabs' }, 'codex')).toEqual({ text: 'Use tabs' })
})

test('the chat mode of meld mcp gives the tools of the main session, and no tool of the plugin store', async () => {
  const { client } = await chatIn()
  const listed = await client.request('tools/list')
  expect((listed.result?.tools as { name: string }[]).map(tool => tool.name).sort()).toEqual(CHAT_TOOLS)
})

test('the chat names ACP agents in the start and add_worker tools, and has no model field, as an ACP agent picks its model', async () => {
  const { client } = await chatIn()
  const listed = await client.request('tools/list')
  const tools = listed.result?.tools as { name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }[]
  const start = tools.find(tool => tool.name === 'start')
  const addWorker = tools.find(tool => tool.name === 'add_worker')
  expect(start?.description).not.toContain('pane')
  expect(Object.keys(start?.inputSchema.properties ?? {}).sort()).toEqual(['agents', 'request', 'vcs'])
  expect(start?.inputSchema.properties.agents?.description).toContain('codex, gemini, cursor')
  expect(addWorker?.inputSchema.properties.agent?.description).toContain('codex, gemini, cursor')
})

test(
  'a chat starts a run of two ACP agents in its repository: the agents plan, do and integrate the work, and the chat delivers it',
  async () => {
    const { client, repo } = await chatIn()
    const started = (await client.call('start', { request: 'Add two files. files: hello.txt, bye.txt', vcs: 'git' })) as { text: string }
    expect(started.text).toContain('2 workers on git')
    const board = await ready(client)
    cleanups.push(runHome(board.id ?? ''))
    expect(board.notices?.some(text => text.includes('the result is ready'))).toBe(true)
    expect(((await client.call('deliver', {})) as { text: string }).text).toStartWith('Merged ')
    expect(await git(repo, 'ls-files')).toBe('README.md\nbye.txt\nhello.txt')
  },
  RUN_MS,
)
