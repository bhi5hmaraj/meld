import { expect, test } from 'claude-code/testing'

import {
  addTasks,
  addWorker,
  bindWorker,
  claimTask,
  finishTask,
  isFailure,
  refuseWorker,
  releaseTask,
  restartWorker,
  resumeWorker,
  setWorkerState,
  splitTask,
  startRun,
  stopWorker,
} from '../core/board'
import type { Change, Run, WorkerId } from '../types'
import { HEAD } from './fake-io'

const NOW = 1_800_000_000_000
const FULL = 'f'.repeat(40)

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

function started(): Run {
  const workers = (['w1', 'w2'] as WorkerId[]).map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: `meld/r1/${id}`, agent: { type: 'meld:worker' } }))
  return startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers })
}

/** Both workers bound, one task added, w1 idle. */
function working(): Run {
  let run = runOf(bindWorker(started(), 'w1', 'agent-1', NOW))
  run = runOf(bindWorker(run, 'w2', 'agent-2', NOW))
  run = runOf(addTasks(run, 'w1', { seen: run.taskList, tasks: [{ title: 'Theme tokens' }] }, NOW))
  return setWorkerState(run, 'w1', 'idle', NOW)
}

test('the bind of a worker in a starting run records a start of the run', () => {
  const run = runOf(bindWorker(started(), 'w1', 'agent-1', NOW))
  expect(run.log.at(-1)).toMatchObject({ by: 'you', kind: 'worker', worker: 'w1', state: 'working', start: 'start' })
})

test('the bind of a worker that joined a working run records a join', () => {
  const run = runOf(bindWorker(addWorker(working(), { id: 'w3', path: '/tmp/meld/r1/w3', ref: 'meld/r1/w3', agent: { type: 'meld:worker' } }, NOW), 'w3', 'agent-3', NOW))
  expect(run.log.at(-1)).toMatchObject({ kind: 'worker', worker: 'w3', state: 'working', start: 'join' })
})

test('a new state of a worker records one worker entry, and the same state again records none', () => {
  const run = working()
  expect(run.log.at(-1)).toMatchObject({ by: 'you', kind: 'worker', worker: 'w1', state: 'idle', text: 'w1 is idle' })
  expect(setWorkerState(run, 'w1', 'idle', NOW + 1000).log).toEqual(run.log)
})

test('a restart records a start of a new agent, with noTask when no task is ready and the worker holds none', () => {
  const run = working()
  const claimed = runOf(claimTask(run, 'w2', 1, 1, NOW))
  const restarted = runOf(restartWorker(claimed, 'w1', 'agent-9', NOW))
  expect(restarted.log.at(-1)).toMatchObject({ kind: 'worker', worker: 'w1', state: 'working', start: 'restart', noTask: true, text: 'w1 starts again' })
})

test('a resume with a ready task records a start in the old session, with no noTask', () => {
  const resumed = runOf(resumeWorker(working(), 'w1', NOW))
  expect(resumed.log.at(-1)).toMatchObject({ kind: 'worker', worker: 'w1', state: 'working', start: 'resume', text: 'w1 goes on in its session' })
  expect(resumed.log.at(-1)?.noTask).toBeUndefined()
})

test('a refused worker and a stopped worker record the state stopped, with their old texts', () => {
  const refused = refuseWorker(started(), 'w2', 'the host limit', NOW)
  expect(refused.log.at(-1)).toMatchObject({ kind: 'worker', worker: 'w2', state: 'stopped', text: 'w2 did not start: the host limit' })
  const stopped = stopWorker(working(), 'w2', NOW)
  expect(stopped.log.at(-1)).toMatchObject({ kind: 'worker', worker: 'w2', state: 'stopped', text: 'stopped w2' })
})

test('the claim, split, release and finish entries name their task', () => {
  let run = runOf(claimTask(working(), 'w1', 1, 1, NOW))
  expect(run.log.at(-1)).toMatchObject({ kind: 'task', task: 1 })
  run = runOf(splitTask(run, 'w1', { task: 1, version: 2, seen: run.taskList, tasks: [{ title: 'Tokens' }, { title: 'Docs' }] }, NOW))
  expect(run.log.at(-1)).toMatchObject({ kind: 'task', task: 1 })
  run = runOf(releaseTask(run, 'w1', 2, 1, '', NOW))
  expect(run.log.at(-1)).toMatchObject({ kind: 'task', task: 2 })
  run = runOf(claimTask(run, 'w2', 3, 1, NOW))
  run = runOf(finishTask(run, 'w2', 3, 2, FULL, 'Docs written', NOW))
  expect(run.log.at(-1)).toMatchObject({ kind: 'task', task: 3 })
})
