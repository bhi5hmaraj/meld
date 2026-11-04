import { expect, test } from 'claude-code/testing'
import type { TurnUsage } from 'claude-code'

import { countStep, guardCall, ownedByAcp, restartIdleWorkers } from '../core/actions'
import { addTasks, bindWorker, isFailure, restartWorker, setWorkerState, startRun } from '../core/board'
import type { Change, Run, WorkerId } from '../types'
import { FakeIo, HEAD } from './fake-io'

const NOW = 1_800_000_000_000
const WINDOW = 200_000
const SMALL = { used: 40_000, size: WINDOW }
const HALF = { used: 100_000, size: WINDOW }
const GRACE_MS = 15_000
const OPEN_STEP = 'meld: These tasks are open: #1 Add the theme. Claim one and do it. Read the board with mcp__meld__board, then go on.'

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

/** One idle worker on `type`, bound to `agentId`, with one open task and the context that its agent last reported. */
function idleWorker(type: string, agentId: string, context?: { used: number; size: number }): Run {
  const ids: WorkerId[] = ['w1']
  const workers = ids.map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: `meld/r1/${id}`, agent: { type } }))
  const started = startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers })
  const bound = runOf(bindWorker(started, 'w1', agentId, NOW))
  const tasked = runOf(addTasks(bound, 'w1', { seen: bound.taskList, tasks: [{ title: 'Add the theme' }] }, NOW))
  const idle = setWorkerState(tasked, 'w1', 'idle', NOW)
  return { ...idle, workers: idle.workers.map(worker => (context ? { ...worker, context } : worker)) }
}

function ioWith(run: Run): FakeIo {
  const io = new FakeIo()
  io.current = run
  io.now = async () => NOW + 60_000
  return io
}

function usageOf(input: number, created: number, read: number, output: number): TurnUsage {
  return { input_tokens: input, cache_creation_input_tokens: created, cache_read_input_tokens: read, output_tokens: output } as TurnUsage
}

test('an idle Claude worker whose context fills less than half of its window goes on in its own session with the step', async () => {
  const io = ioWith(idleWorker('meld:worker', 'agent-1', SMALL))
  await restartIdleWorkers(io)
  expect(io.resumed).toEqual([`agent-1: ${OPEN_STEP}`])
  expect(io.spawned).toEqual([])
  expect(io.current?.workers[0]).toMatchObject({ agentId: 'agent-1', state: 'working', activity: 'goes on', resumedAt: NOW + 60_000 })
  expect(io.current?.log.at(-1)?.text).toBe('w1 goes on in its session')
})

test('an idle worker whose context fills half of its window gets a fresh agent, which the claim gives the handovers', async () => {
  const io = ioWith(idleWorker('meld:worker', 'agent-1', HALF))
  await restartIdleWorkers(io)
  expect(io.resumed).toEqual([])
  expect(io.spawned.map(spawn => spawn.description)).toEqual(['meld w1'])
  expect(io.current?.workers[0]).toMatchObject({ agentId: 'spawned-1', state: 'working' })
  expect(io.current?.workers[0]?.context).toBeUndefined()
})

test('a worker with no known context gets a fresh agent, as before', async () => {
  const io = ioWith(idleWorker('meld:worker', 'agent-1'))
  await restartIdleWorkers(io)
  expect(io.resumed).toEqual([])
  expect(io.spawned.map(spawn => spawn.description)).toEqual(['meld w1'])
})

test('a worker whose old agent the host cannot reach gets a fresh agent', async () => {
  const io = ioWith(idleWorker('meld:worker', 'agent-1', SMALL))
  io.gone = ['agent-1']
  await restartIdleWorkers(io)
  expect(io.resumed).toEqual([])
  expect(io.spawned.map(spawn => spawn.description)).toEqual(['meld w1'])
})

test('meld mcp lets an idle ACP worker with a small context go on in its own session', async () => {
  const io = ioWith(idleWorker('acp:codex', 'acp-1', SMALL))
  await restartIdleWorkers(io, ownedByAcp)
  expect(io.resumed).toEqual([`acp-1: ${OPEN_STEP}`])
  expect(io.spawned).toEqual([])
})

test('a model call of a worker records its context: the whole input of the call, against the window of its model', async () => {
  const io = ioWith(idleWorker('meld:worker', 'agent-1'))
  await countStep(io, 'agent-1', usageOf(1000, 2000, 30_000, 500), WINDOW)
  expect(io.current?.workers[0]).toMatchObject({ tokens: 3500, context: { used: 33_000, size: WINDOW } })
})

test('a new agent of a worker starts with no context', () => {
  const run = idleWorker('meld:worker', 'agent-1', SMALL)
  const resumed = { ...run, state: 'working' as const, workers: run.workers.map(worker => ({ ...worker, resumedAt: NOW })) }
  const restarted = runOf(restartWorker(resumed, 'w1', 'agent-2', NOW + 1000))
  expect(restarted.workers[0]?.context).toBeUndefined()
  expect(restarted.workers[0]?.resumedAt).toBeUndefined()
})

test('meld keeps a resumed worker working while the agent list still shows the turn before the resume as ended', async () => {
  const run = idleWorker('meld:worker', 'agent-1', SMALL)
  const working: Run = { ...run, workers: run.workers.map(worker => ({ ...worker, state: 'working', resumedAt: NOW + 50_000, activityAt: NOW + 50_000 })) }
  const io = ioWith(working)
  io.agentStates = new Map([['agent-1', 'ended']])
  await restartIdleWorkers(io)
  expect(io.resumed).toEqual([])
  expect(io.current?.workers[0]?.state).toBe('working')
  io.now = async () => NOW + 50_000 + GRACE_MS + 1
  await restartIdleWorkers(io)
  expect(io.resumed).toEqual([`agent-1: ${OPEN_STEP}`])
})

test('the hand-back of a worker marks it idle at once, as meld may not see the end of its turn', async () => {
  const run = idleWorker('meld:worker', 'agent-1', SMALL)
  const io = ioWith({ ...run, workers: run.workers.map(worker => ({ ...worker, state: 'working' })) })
  expect(await guardCall(io, { tool: 'SubagentHandback', agentId: 'agent-1' })).toBeUndefined()
  expect(io.current?.workers[0]?.state).toBe('idle')
})
