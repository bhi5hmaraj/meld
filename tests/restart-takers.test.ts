import { expect, test } from 'claude-code/testing'
import type { ToolCallInput } from 'claude-code'

import { markWorker, restartIdleWorkers, serveTool } from '../hooks/actions'
import { addTasks, addWorker as joinRun, bindWorker, claimTask, isFailure, startRun, takeIntegration } from '../hooks/board'
import type { Change, NewTask, Run, WorkerId } from '../types'
import { FakeIo, HEAD } from './fake-io'

const NOW = 1_800_000_000_000

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

/** Three workers at work: agent-1 runs w1, agent-2 runs w2, agent-3 runs w3. */
function working(): Run {
  const ids: WorkerId[] = ['w1', 'w2', 'w3']
  const workers = ids.map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: `meld/r1/${id}`, agent: { type: 'meld:worker' } }))
  let run = startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers })
  for (const [index, id] of ids.entries()) run = runOf(bindWorker(run, id, `agent-${index + 1}`, NOW))
  return run
}

function withTasks(tasks: NewTask[]): Run {
  const run = working()
  return runOf(addTasks(run, 'w1', { seen: run.taskList, tasks }, NOW))
}

function ioWith(run: Run): FakeIo {
  const io = new FakeIo()
  io.current = run
  return io
}

function call(input: Record<string, unknown>): ToolCallInput {
  return input as unknown as ToolCallInput
}

test('a worker that meld started again for an open task takes it until it claims: the next beat starts no second agent for it', async () => {
  const io = ioWith(runOf(claimTask(withTasks([{ title: 'Tokens' }, { title: 'Docs' }]), 'w1', 1, 1, NOW)))
  await markWorker(io, 'agent-2', 'idle')
  await markWorker(io, 'agent-3', 'idle')
  await restartIdleWorkers(io)
  await restartIdleWorkers(io)
  expect(io.spawned.map(spawn => spawn.description)).toEqual(['meld w2'])
  expect(io.spawned[0]?.prompt).toContain('These tasks are open: #2 Docs. Claim one and do it.')
  expect(io.current?.workers.map(worker => worker.state)).toEqual(['working', 'working', 'idle'])
})

test('a worker that meld started again counts as a taker only until it claims: then an idle worker starts for the next open task', async () => {
  const io = ioWith(runOf(claimTask(withTasks([{ title: 'Tokens' }, { title: 'Docs' }, { title: 'Toggle' }]), 'w1', 1, 1, NOW)))
  await markWorker(io, 'agent-2', 'idle')
  await restartIdleWorkers(io)
  await serveTool(io, call({ tool: 'mcp__meld__claim', task: 2, version: 1, agentId: 'spawned-1' }))
  await markWorker(io, 'agent-3', 'idle')
  await restartIdleWorkers(io)
  expect(io.spawned.map(spawn => spawn.description)).toEqual(['meld w2', 'meld w3'])
  expect(io.spawned[1]?.prompt).toContain('These tasks are open: #3 Toggle. Claim one and do it.')
})

test('while the integrator works and no task is open, a beat starts no other worker', async () => {
  const io = ioWith(runOf(takeIntegration(working(), 'w2', NOW)))
  await markWorker(io, 'agent-1', 'idle')
  await markWorker(io, 'agent-3', 'idle')
  await restartIdleWorkers(io)
  expect(io.spawned).toHaveLength(0)
})

test('the integrator takes no open task: while it works with no claim, a beat starts an idle worker for the open task', async () => {
  const io = ioWith(runOf(takeIntegration(withTasks([{ title: 'Docs' }]), 'w1', NOW)))
  await markWorker(io, 'agent-2', 'idle')
  await markWorker(io, 'agent-3', 'idle')
  await restartIdleWorkers(io)
  expect(io.spawned.map(spawn => spawn.description)).toEqual(['meld w2'])
  expect(io.spawned[0]?.prompt).toContain('These tasks are open: #1 Docs. Claim one and do it.')
})

test('a worker that is starting with no agent takes no open task: a beat starts an idle worker for it', async () => {
  const run = runOf(claimTask(withTasks([{ title: 'Tokens' }, { title: 'Docs' }]), 'w1', 1, 1, NOW))
  const io = ioWith(joinRun(run, { id: 'w4', path: '/tmp/meld/r1/w4', ref: 'meld/r1/w4', agent: { type: 'meld:worker' } }, NOW))
  await markWorker(io, 'agent-2', 'idle')
  await markWorker(io, 'agent-3', 'idle')
  await restartIdleWorkers(io)
  expect(io.current?.workers.map(worker => worker.state)).toEqual(['working', 'working', 'idle', 'starting'])
  expect(io.spawned.map(spawn => spawn.description)).toEqual(['meld w2'])
})
