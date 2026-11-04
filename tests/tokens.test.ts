import { expect, test } from 'claude-code/testing'
import type { TurnUsage } from 'claude-code'

import { countStep, markWorker } from '../hooks/actions'
import { bindWorker, isFailure, startRun } from '../hooks/board'
import type { Change, Run, WorkerId } from '../types'
import { FakeIo, HEAD } from './fake-io'

const NOW = 1_800_000_000_000

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

function ioWithWorkers(): FakeIo {
  const ids: WorkerId[] = ['w1', 'w2']
  const workers = ids.map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: `meld/r1/${id}`, agent: { type: 'meld:worker' } }))
  let run = startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers })
  for (const [index, id] of ids.entries()) run = runOf(bindWorker(run, id, `agent-${index + 1}`, NOW))
  const io = new FakeIo()
  io.current = run
  return io
}

function usageOf(input: number, created: number, read: number, output: number): TurnUsage {
  return { input_tokens: input, cache_creation_input_tokens: created, cache_read_input_tokens: read, output_tokens: output } as TurnUsage
}

test('each model call of a worker adds its fresh tokens to the worker at once, in a long turn too', async () => {
  const io = ioWithWorkers()
  await countStep(io, 'agent-1', usageOf(100, 10, 5000, 50))
  await countStep(io, 'agent-1', usageOf(20, 0, 5200, 30))
  expect(io.current?.workers.map(worker => [worker.id, worker.tokens, worker.state])).toEqual([
    ['w1', 210, 'working'],
    ['w2', 0, 'working'],
  ])
})

test('a model call of the main session, of an agent that is no worker, or with no usage counts nothing', async () => {
  const io = ioWithWorkers()
  const before = io.current
  await countStep(io, undefined, usageOf(100, 0, 0, 50))
  await countStep(io, 'agent-9', usageOf(100, 0, 0, 50))
  await countStep(io, 'agent-1', null)
  expect(io.current).toBe(before)
})

test('the end of a turn adds no tokens, so that no model call counts two times', async () => {
  const io = ioWithWorkers()
  await countStep(io, 'agent-1', usageOf(100, 0, 0, 50))
  await markWorker(io, 'agent-1', 'idle')
  expect(io.current?.workers[0]).toMatchObject({ tokens: 150, state: 'idle' })
})
