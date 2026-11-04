import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { bindWorker, isFailure, startRun } from '../core/board'
import type { Change, Run } from '../types'
import type { AcpUpdate } from './acp'
import { AcpRunner } from './leader'
import { SqliteBoards } from './sqlite-store'

const BOARD = 'leader-session'
const STUB = { stub: ['bun', join(import.meta.dir, 'stub-agent.spec-helper.ts')] }
const NUDGES_AT_THE_LIMIT = 4
const runners: AcpRunner[] = []
const folders: string[] = []

type Setup = { boards: SqliteBoards; folder: string; runner: AcpRunner; updates: AcpUpdate[] }

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

/** A board with a run of one worker, w1, that the stub ACP agent runs in a folder of its own. */
async function setup(): Promise<Setup> {
  const folder = mkdtempSync(join(tmpdir(), 'meld-leader-'))
  folders.push(folder)
  const boards = new SqliteBoards(':memory:')
  const workers = [{ id: 'w1' as const, path: folder, ref: 'meld/r1/w1', agent: { type: 'acp:stub' } }]
  await boards.board(BOARD).write(() => startRun({ id: 'r1', request: 'Add a greeting', repo: folder, base: 'a'.repeat(40), vcs: 'git', now: Date.now(), workers }))
  const updates: AcpUpdate[] = []
  const runner = new AcpRunner(boards, { commands: STUB, onUpdate: (_, update) => updates.push(update), pollMs: 20 })
  runners.push(runner)
  return { boards, folder, runner, updates }
}

async function spawnBound(setup: Setup, prompt: string): Promise<string> {
  const spawned = await setup.runner.spawn(BOARD, { prompt, description: 'meld w1', subagentType: 'acp:stub', cwd: setup.folder })
  const agentId = spawned.agentId ?? ''
  await setup.boards.board(BOARD).write(run => run && runOf(bindWorker(run, 'w1', agentId, Date.now())))
  return agentId
}

async function until(check: () => boolean): Promise<void> {
  for (let wait = 0; wait < 400 && !check(); wait++) await Bun.sleep(25)
  if (!check()) throw new Error('it did not happen')
}

function texts(updates: readonly AcpUpdate[]): string[] {
  return updates.map(update => update.text)
}

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stopAll()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

test('a worker that the leader starts gets the worker prompt in its folder, and its tool call becomes its activity', async () => {
  const one = await setup()
  await spawnBound(one, 'Read the board')
  await until(() => one.boards.read(BOARD).run?.workers[0]?.activity === `Edit ${one.folder}/a.txt`)
  expect(texts(one.updates).some(text => text.startsWith('turn 1: You are a meld worker'))).toBe(true)
})

test('an idle ACP worker starts again in a fresh agent with the step of meld, until the nudges run out and the person hears it', async () => {
  const one = await setup()
  const first = await spawnBound(one, 'Read the board')
  await until(() => one.boards.read(BOARD).run?.nudges === NUDGES_AT_THE_LIMIT)
  expect(one.boards.read(BOARD).run?.workers[0]?.agentId).not.toBe(first)
  expect(one.runner.states().get(first)).toBeUndefined()
  expect(one.boards.takeActions(BOARD, 'engine').map(action => action.kind)).toEqual(['toast'])
})

test('a message to a busy ACP worker waits for its prompt to end, then continues the same session', async () => {
  const one = await setup()
  const agentId = await spawnBound(one, 'Read the board [pause]')
  await until(() => texts(one.updates).some(text => text.startsWith('turn 1:')))
  expect(one.runner.states().get(agentId)).toBe('live')
  await one.runner.send(agentId, 'One more thing')
  await until(() => texts(one.updates).includes('turn 2: One more thing'))
})

test('a message of a worker of meld mcp to an ACP agent reaches it, and the plugin takes the rest of the actions', async () => {
  const one = await setup()
  const agentId = await spawnBound(one, 'Read the board [pause]')
  one.boards.addAction({ board: BOARD, kind: 'send', agent: agentId, text: 'News from w2', at: Date.now() })
  one.boards.addAction({ board: BOARD, kind: 'send', agent: 'agent-9', text: 'For a Claude worker', at: Date.now() })
  await until(() => texts(one.updates).includes('turn 2: News from w2'))
  expect(one.boards.takeActions(BOARD, 'engine').map(action => action.text)).toEqual(['For a Claude worker'])
})

test('a stop ends the agent of an ACP worker', async () => {
  const one = await setup()
  const agentId = await spawnBound(one, 'Read the board [wait]')
  await until(() => one.runner.states().get(agentId) === 'live')
  await one.runner.stop(agentId)
  expect(one.runner.states().get(agentId)).toBeUndefined()
})
