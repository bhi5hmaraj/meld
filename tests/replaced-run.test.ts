import { expect, test } from 'claude-code/testing'
import type { ToolCallInput } from 'claude-code'

import { addWorker, deliver, markWorker, restartIdleWorkers, serveTool, startRun } from '../core/actions'
import { addTasks, bindWorker, claimTask, declareFinal, isFailure, startRun as startBoard, takeIntegration } from '../core/board'
import type { Change, Run, WorkerId } from '../types'
import { FakeIo, HEAD } from './fake-io'

const NOW = 1_800_000_000_000
const FULL = 'f'.repeat(40)
const IDS: WorkerId[] = ['w1', 'w2', 'w3']
const WORKER = { type: 'meld:worker' }
const ENDED = 'meld stopped you. End your turn now.'

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

/** A run whose three workers wait for their agents. */
function starting(id: string): Run {
  const workers = IDS.map(worker => ({ id: worker, path: `/tmp/meld/${id}/${worker}`, ref: `meld/${id}/${worker}`, agent: WORKER }))
  return startBoard({ id, request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers })
}

/** agent-1 runs w1, agent-2 runs w2, agent-3 runs w3. */
function bound(id: string): Run {
  let run = starting(id)
  for (const [index, worker] of IDS.entries()) run = runOf(bindWorker(run, worker, `agent-${index + 1}`, NOW))
  return run
}

/** Two tasks, and w1 claims #1. */
function planned(id: string): Run {
  const run = runOf(addTasks(bound(id), 'w1', { seen: 0, tasks: [{ title: 'Theme tokens' }, { title: 'Docs' }] }, NOW))
  return runOf(claimTask(run, 'w1', 1, 1, NOW))
}

function ioWith(run: Run | null): FakeIo {
  const io = new FakeIo()
  io.current = run
  return io
}

function call(input: Record<string, unknown>): ToolCallInput {
  return input as unknown as ToolCallInput
}

test('a run that replaces a starting run while the engine starts its agents takes none of them: each hears to end its turn', async () => {
  const io = ioWith(null)
  const other = starting('r2')
  io.during['meld w1'] = () => other
  const result = await startRun(io, '/repo', { request: 'Add a dark theme', agents: [WORKER, WORKER], vcs: 'git' })
  expect(result.text).toBe('No worker started: the run ended.')
  expect(io.current).toEqual(other)
  expect(io.sent).toEqual([`spawned-1: ${ENDED}`, `spawned-2: ${ENDED}`])
})

test('a run that replaces the run while meld makes the workspace of a new worker gets no worker, and meld removes that workspace', async () => {
  const io = ioWith(bound('r1'))
  const other = bound('r2')
  const made = `git worktree add -b meld/r1/w4 /tmp/meld/r1/w4 ${HEAD}`
  io.during[made] = () => other
  expect(await addWorker(io, '')).toBe('w4 did not join: the run ended while meld made its workspace.')
  expect(io.current).toEqual(other)
  expect(io.spawned).toHaveLength(0)
  expect(io.commands.slice(io.commands.indexOf(made) + 1)).toEqual(expect.arrayContaining(['rm -rf -- /tmp/meld/r1', 'git branch -D meld/r1/w4']))
})

test('a run that replaces the run while meld starts a worker again keeps its own agents, and the new agent hears to end its turn', async () => {
  const io = ioWith(planned('r1'))
  await markWorker(io, 'agent-2', 'idle')
  await markWorker(io, 'agent-3', 'idle')
  const other = planned('r2')
  io.during['meld w2'] = () => other
  expect(await restartIdleWorkers(io)).toEqual([])
  expect(io.current).toEqual(other)
  expect(io.sent).toContain(`spawned-1: ${ENDED}`)
})

test('a run that replaces the run during the merge of its delivery stays as it is', async () => {
  const io = ioWith(runOf(declareFinal(runOf(takeIntegration(bound('r1'), 'w2', NOW)), 'w2', FULL, 'Done', NOW)))
  const other = bound('r2')
  io.during[`git merge --no-ff -m meld: Done\n\nAdd a dark theme ${FULL}`] = () => other
  expect(await deliver(io)).toBe(`Merged ${FULL.slice(0, 7)} into your branch.`)
  expect(io.current).toEqual(other)
})

test('a run that replaces the run during the merge of a finished task into the integration line stays as it is', async () => {
  const io = ioWith(planned('r1'))
  io.answers[`git rev-parse --verify --quiet ${FULL}^{commit}`] = FULL
  io.failing = [`git merge-base --is-ancestor ${FULL} ${HEAD}`]
  const other = planned('r2')
  io.during[`git update-ref refs/heads/meld/r1/integration ${FULL} `] = () => other
  await serveTool(io, call({ tool: 'mcp__meld__finish_task', task: 1, version: 2, commit: FULL, summary: 'Tokens', agentId: 'agent-1' }))
  expect(io.commands).toContain(`git update-ref refs/heads/meld/r1/integration ${FULL} `)
  expect(io.current).toEqual(other)
})
