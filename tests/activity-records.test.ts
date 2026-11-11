import { expect, test } from 'claude-code/testing'
import type { TurnUsage } from 'claude-code'

import { countStep, markWorker, noteTime, recordActivity, recordContext, timeCall } from '../core/actions'
import { addTasks, bindWorker, claimTask, CONTEXT_CAP, isFailure, restartWorker, startRun } from '../core/board'
import type { Change, Run, WorkerId } from '../types'
import { FakeIo, HEAD } from './fake-io'

const NOW = 1_800_000_000_000
const WINDOW = 1_000_000

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

/** w1 and w2 bound; w1 holds task 1. */
function claimed(): Run {
  const workers = (['w1', 'w2'] as WorkerId[]).map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: `meld/r1/${id}`, agent: { type: 'meld:worker' } }))
  let run = startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers })
  run = runOf(bindWorker(run, 'w1', 'agent-1', NOW))
  run = runOf(bindWorker(run, 'w2', 'agent-2', NOW))
  run = runOf(addTasks(run, 'w1', { seen: run.taskList, tasks: [{ title: 'Theme tokens' }] }, NOW))
  return runOf(claimTask(run, 'w1', 1, 1, NOW))
}

function ioOf(run: Run): FakeIo {
  const io = new FakeIo()
  io.current = run
  return io
}

function usageOf(input: number, created: number, read: number, output: number): TurnUsage {
  return { input_tokens: input, cache_creation_input_tokens: created, cache_read_input_tokens: read, output_tokens: output } as TurnUsage
}

test('each model call of a worker adds its tokens by kind and one step to the worker, and its tokens to the task it holds', async () => {
  const io = ioOf(claimed())
  await countStep(io, 'agent-1', usageOf(100, 10, 5000, 50))
  await countStep(io, 'agent-1', usageOf(20, 0, 5200, 30))
  const sums = { input: 120, cacheWrite: 10, cacheRead: 10_200, output: 80 }
  expect(io.current?.workers[0]).toMatchObject({ usage: sums, steps: 2 })
  expect(io.current?.tasks[0]?.usage).toEqual(sums)
  expect(io.current?.workers[1]?.usage).toBeUndefined()
})

test('the largest context of a worker is the largest context of its model calls and of the reports of its agent', async () => {
  const io = ioOf(claimed())
  await countStep(io, 'agent-1', usageOf(100, 10, 5000, 50), WINDOW)
  await countStep(io, 'agent-1', usageOf(20, 0, 3000, 30), WINDOW)
  expect(io.current?.workers[0]?.largestContext).toBe(5110)
  await recordContext(io, 'agent-1', { used: 9000, size: WINDOW })
  expect(io.current?.workers[0]?.largestContext).toBe(9000)
})

test('the time of tool calls and model calls adds up by activity on the worker and its task, in the next model call', async () => {
  const io = ioOf(claimed())
  timeCall({ tool: 'Bash', command: 'bun test mcp/', agentId: 'agent-1' } as never, 500)
  timeCall({ tool: 'Read', file_path: '/tmp/meld/r1/w1/a.ts', agentId: 'agent-1' } as never, 20)
  timeCall({ tool: 'mcp__meld__board', agentId: 'agent-1' } as never, 30)
  noteTime('agent-1', 'model', 300)
  expect(io.current?.workers[0]?.times).toBeUndefined()
  await countStep(io, 'agent-1', usageOf(100, 0, 0, 50))
  const times = { tests: 500, tools: 20, board: 30, model: 300 }
  expect(io.current?.workers[0]?.times).toEqual(times)
  expect(io.current?.tasks[0]?.times).toEqual(times)
})

test('the time of an ACP worker is written with its next tool call and at the end of its prompt', async () => {
  const io = ioOf(claimed())
  noteTime('agent-1', 'builds', 700)
  await recordActivity(io, 'agent-1', 'Run tsc')
  expect(io.current?.workers[0]?.times).toEqual({ builds: 700 })
  noteTime('agent-1', 'model', 900)
  await markWorker(io, 'agent-1', 'idle')
  expect(io.current?.workers[0]?.times).toEqual({ builds: 700, model: 900 })
})

test('the time of an agent is written once', async () => {
  const io = ioOf(claimed())
  noteTime('agent-1', 'model', 300)
  await countStep(io, 'agent-1', usageOf(100, 0, 0, 50))
  await countStep(io, 'agent-1', usageOf(100, 0, 0, 50))
  expect(io.current?.workers[0]?.times).toEqual({ model: 300 })
})

test('a fresh agent for a worker at the context cap counts as a cap start, and one below the cap does not', () => {
  const run = claimed()
  const atCap = { ...run, workers: run.workers.map(worker => ({ ...worker, context: { used: worker.id === 'w1' ? CONTEXT_CAP : CONTEXT_CAP - 1, size: WINDOW } })) }
  const restarted = runOf(restartWorker(runOf(restartWorker(atCap, 'w1', 'agent-3', NOW)), 'w2', 'agent-4', NOW))
  expect(restarted.workers.map(worker => worker.capStarts)).toEqual([1, undefined])
})
