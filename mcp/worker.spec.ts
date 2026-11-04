import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { bindWorker, isFailure, runId, startRun } from '../core/board'
import { runHome, vcsFor } from '../core/vcs'
import type { Change, Run, Task, WorkerId } from '../types'
import { Client } from './client.spec-helper'
import { bunCodeHost } from './code-host'
import { SqliteBoards } from './sqlite-store'

const BOARD = 'leader-session'
const IDS: WorkerId[] = ['w1', 'w2']
const WORKER_TOOLS = ['add_tasks', 'board', 'check', 'claim', 'finish', 'finish_task', 'integrate', 'note', 'release', 'share', 'split']
const cleanups: string[] = []

type Fixture = { db: string; repo: string; run: Run }
type View = { you: { id: string; path: string }; rules?: string; taskList: number; tasks: Task[] }

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await bunCodeHost.run(['git', ...args], cwd)
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

/** A repository with one commit, and a run of two workers in git worktrees: w1 held by the ACP agent acp-1, w2 by a Claude agent. */
async function fixture(): Promise<Fixture> {
  const folder = mkdtempSync(join(tmpdir(), 'meld-worker-'))
  cleanups.push(folder)
  const repo = join(folder, 'repo')
  await git(folder, 'init', '-q', '-b', 'main', repo)
  await git(repo, 'config', 'user.email', 'meld@example.com')
  await git(repo, 'config', 'user.name', 'meld')
  await Bun.write(join(repo, 'README.md'), 'base\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-q', '-m', 'base')
  const base = await git(repo, 'rev-parse', 'HEAD')
  const id = runId(Date.now(), crypto.getRandomValues(new Uint8Array(4)))
  cleanups.push(runHome(id))
  const prepared = await vcsFor('git').prepare(bunCodeHost, { id, repo, base }, IDS)
  if ('error' in prepared) throw new Error(prepared.error)
  const workers = IDS.map((worker, index) => ({ id: worker, path: prepared.workspaces[index]?.path ?? '', ref: prepared.workspaces[index]?.ref ?? '', agent: { type: 'meld:worker' } }))
  const started = startRun({ id, request: 'Add a greeting', repo, base, vcs: 'git', now: Date.now(), workers })
  const run = runOf(bindWorker(runOf(bindWorker(started, 'w1', 'acp-1', Date.now())), 'w2', 'agent-2', Date.now()))
  const db = join(folder, 'meld.db')
  const boards = new SqliteBoards(db)
  await boards.board(BOARD).write(() => run)
  boards.close()
  return { db, repo, run }
}

function workerClient(db: string, agent = 'acp-1'): Client {
  return new Client(db, ['--worker'], { MELD_BOARD: BOARD, MELD_AGENT: agent })
}

afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true })
})

test('the worker mode of meld mcp lists the board tools of a worker, and no tool of the main session', async () => {
  const { db } = await fixture()
  const client = workerClient(db)
  const listed = await client.request('tools/list')
  expect((listed.result?.tools as { name: string }[]).map(tool => tool.name).sort()).toEqual(WORKER_TOOLS)
  expect(await client.end()).toBe(0)
})

test('a board read in worker mode gives the rules and the folder of the worker that the agent holds', async () => {
  const { db, run } = await fixture()
  const client = workerClient(db)
  const view = (await client.call('board', {})) as View
  expect(view.you).toMatchObject({ id: 'w1', path: run.workers[0]?.path })
  expect(view.rules).toBeDefined()
  await client.end()
})

test('a task that a worker adds wakes the other working worker through a row for the leader', async () => {
  const { db } = await fixture()
  const client = workerClient(db)
  const view = (await client.call('board', {})) as View
  expect(await client.call('add_tasks', { seen: view.taskList, tasks: [{ title: 'Add a greeting file' }] })).toMatchObject({ ok: true })
  await client.end()
  const actions = new SqliteBoards(db).takeActions(BOARD, 'engine')
  expect(actions.map(action => [action.kind, action.agent])).toEqual([['send', 'agent-2']])
  expect(actions[0]?.text).toContain('open work')
})

test('a finished task of the worker merges its commit into the integration line of the run', async () => {
  const { db, repo, run } = await fixture()
  const client = workerClient(db)
  const read = (await client.call('board', {})) as View
  await client.call('add_tasks', { seen: read.taskList, tasks: [{ title: 'Add a greeting file' }] })
  const open = ((await client.call('board', {})) as View).tasks[0]
  expect(await client.call('claim', { task: open?.id, version: open?.version })).toMatchObject({ ok: true })
  const folder = run.workers[0]?.path ?? ''
  await Bun.write(join(folder, 'hello.txt'), 'hello from meld\n')
  await git(folder, 'add', 'hello.txt')
  await git(folder, 'commit', '-q', '-m', 'Add hello.txt')
  const commit = await git(folder, 'rev-parse', 'HEAD')
  const claimed = ((await client.call('board', {})) as View).tasks[0]
  expect(await client.call('finish_task', { task: claimed?.id, version: claimed?.version, commit: 'HEAD', summary: 'Added hello.txt' })).toMatchObject({ ok: true })
  await client.end()
  expect(await git(repo, 'merge-base', '--is-ancestor', commit, `meld/${run.id}/integration`)).toBe('')
})

test('an agent that holds no worker gets NOT_WORKER, and the worker mode needs its board and agent', async () => {
  const { db } = await fixture()
  const stranger = workerClient(db, 'acp-9')
  expect(await stranger.call('note', { text: 'hello' })).toMatchObject({ error: 'NOT_WORKER' })
  await stranger.end()
  expect(await new Client(db, ['--worker']).end()).toBe(1)
})
