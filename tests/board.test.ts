import { expect, test } from 'claude-code/testing'

import {
  addCheck,
  addNote,
  addTasks,
  bindWorker,
  boardFor,
  claimTask,
  declareFinal,
  finishTask,
  isFailure,
  releaseTask,
  startRun,
  steer,
  stopRun,
  stopWorker,
  takeIntegration,
  takeNotice,
  workerOf,
} from '../hooks/board'
import type { Change, Run } from '../types'

const NOW = 1_800_000_000_000
const WORKERS = [
  { path: '/tmp/meld/r1/w1', branch: 'meld/r1/w1' },
  { path: '/tmp/meld/r1/w2', branch: 'meld/r1/w2' },
]

function fresh(): Run {
  return startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: 'abc1234', now: NOW, workers: WORKERS })
}

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

function working(): Run {
  return runOf(bindWorker(runOf(bindWorker(fresh(), 'w1', 'agent-1', NOW)), 'w2', 'agent-2', NOW))
}

function withTask(): Run {
  return runOf(addTasks(working(), 'w1', { seen: 0, tasks: [{ title: 'Theme tokens', detail: 'CSS variables' }] }, NOW))
}

test('a new run waits for its two workers', () => {
  const run = fresh()
  expect(run.state).toBe('starting')
  expect(run.revision).toBe(1)
  expect(run.workers.map(worker => worker.id)).toEqual(['w1', 'w2'])
})

test('a run works once both workers are bound', () => {
  const run = working()
  expect(run.state).toBe('working')
  expect(workerOf(run, 'agent-2')?.id).toBe('w2')
})

test('a bound worker cannot be bound again', () => {
  expect(bindWorker(working(), 'w1', 'agent-3', NOW)).toMatchObject({ error: 'TAKEN' })
})

test('a worker claims an open task', () => {
  const run = runOf(claimTask(withTask(), 'w2', 1, 1, NOW))
  expect(run.tasks[0]).toMatchObject({ state: 'claimed', owner: 'w2', version: 2 })
})

test('a claimed task refuses the other worker', () => {
  const run = runOf(claimTask(withTask(), 'w2', 1, 1, NOW))
  expect(claimTask(run, 'w1', 1, 2, NOW)).toMatchObject({ error: 'TAKEN' })
})

test('a claim with an old version is stale', () => {
  const run = runOf(claimTask(withTask(), 'w2', 1, 1, NOW))
  expect(claimTask(run, 'w2', 1, 1, NOW)).toMatchObject({ error: 'STALE_VERSION' })
})

test('only the owner finishes a task, with its commit', () => {
  const run = runOf(claimTask(withTask(), 'w1', 1, 1, NOW))
  expect(finishTask(run, 'w2', 1, 2, 'def5678', 'Tokens added', NOW)).toMatchObject({ error: 'NOT_OWNER' })
  expect(runOf(finishTask(run, 'w1', 1, 2, 'def5678', 'Tokens added', NOW)).tasks[0]).toMatchObject({ state: 'done', commit: 'def5678' })
})

test('a released task is open again', () => {
  const run = runOf(claimTask(withTask(), 'w1', 1, 1, NOW))
  const released = runOf(releaseTask(run, 'w1', 1, 2, 'Half done on meld/r1/w1', NOW))
  expect(released.tasks[0]).toMatchObject({ state: 'open', version: 3 })
  expect(released.tasks[0]?.owner).toBeUndefined()
})

test('a steer raises the revision and each worker sees it once', () => {
  const steered = runOf(steer(working(), 'Use the brand colours', NOW))
  expect(steered.revision).toBe(2)
  const first = boardFor(steered, 'w1')
  expect(first.view.notice?.steers).toEqual(['Use the brand colours'])
  expect(boardFor(first.run, 'w1').view.notice).toBeUndefined()
})

test('a worker that has not read a steer still claims work and the run keeps working', () => {
  const steered = runOf(steer(withTask(), 'Use the brand colours', NOW))
  const run = runOf(claimTask(steered, 'w1', 1, 1, NOW))
  expect(run.tasks[0]).toMatchObject({ state: 'claimed', owner: 'w1' })
  expect(run.state).toBe('working')
})

test('one worker integrates at a time', () => {
  const run = runOf(takeIntegration(working(), 'w2', NOW))
  expect(run.integrator).toBe('w2')
  expect(takeIntegration(run, 'w1', NOW)).toMatchObject({ error: 'INTEGRATION_TAKEN' })
})

test('the integrator declares the final commit and the run is ready', () => {
  const run = runOf(takeIntegration(working(), 'w2', NOW))
  expect(declareFinal(run, 'w1', 'fff0000', 'All done', NOW)).toMatchObject({ error: 'NOT_INTEGRATOR' })
  const ready = runOf(declareFinal(run, 'w2', 'fff0000', 'All done', NOW))
  expect(ready.state).toBe('ready')
  expect(ready.final).toEqual({ commit: 'fff0000', summary: 'All done', by: 'w2' })
})

test('a stopped run refuses work but still shows its board', () => {
  const stopped = stopRun(withTask(), NOW)
  expect(stopped.workers.map(worker => worker.state)).toEqual(['stopped', 'stopped'])
  expect(claimTask(stopped, 'w1', 1, 1, NOW)).toMatchObject({ error: 'RUN_ENDED' })
  expect(boardFor(stopped, 'w1').view.state).toBe('stopped')
})

test('a steer of a stopped run is refused', () => {
  expect(steer(stopRun(working(), NOW), 'More', NOW)).toMatchObject({ error: 'RUN_ENDED' })
})

test('a steer of a ready run asks for changes and the run works again', () => {
  const integrating = runOf(takeIntegration(working(), 'w2', NOW))
  const ready = runOf(declareFinal(integrating, 'w2', 'fff0000', 'All done', NOW))
  const changed = runOf(steer(ready, 'Rename the toggle', NOW))
  expect(changed.state).toBe('working')
  expect(changed.final).toBeUndefined()
  expect(changed.integrator).toBe('w2')
})

test('a tool reply carries a new steer once and leaves the news unread', () => {
  const noted = runOf(addNote(working(), 'w1', 'The theme lives in theme.css', undefined, NOW))
  const steered = runOf(steer(noted, 'Use the brand colours', NOW))
  const taken = takeNotice(steered, 'w2')
  expect(taken.notice?.steers).toEqual(['Use the brand colours'])
  expect(takeNotice(taken.run, 'w2').notice).toBeUndefined()
  expect(boardFor(taken.run, 'w2').view.news.map(entry => entry.kind)).toEqual(['note'])
})

test('a stopped worker gives back its claimed tasks and the integration', () => {
  const claimed = runOf(claimTask(withTask(), 'w1', 1, 1, NOW))
  const integrating = runOf(takeIntegration(claimed, 'w1', NOW))
  const stopped = stopWorker(integrating, 'w1', NOW)
  expect(stopped.tasks[0]).toMatchObject({ state: 'open', version: 3 })
  expect(stopped.integrator).toBeUndefined()
  expect(stopped.workers[0]?.state).toBe('stopped')
  expect(stopped.state).toBe('working')
})

test('notes and checks of one worker are news for the other worker only', () => {
  const noted = runOf(addNote(working(), 'w1', 'The theme lives in theme.css', undefined, NOW))
  const checked = runOf(addCheck(noted, 'w1', { command: 'pnpm test', commit: 'abc1234', passed: true, output: '' }, NOW))
  expect(boardFor(checked, 'w2').view.news.map(entry => entry.kind)).toEqual(['note', 'check'])
  expect(boardFor(checked, 'w1').view.news).toHaveLength(0)
})

test('a worker adds a batch of tasks when it has seen the current task list', () => {
  const run = runOf(addTasks(working(), 'w1', { seen: 0, tasks: [{ title: 'Tokens' }, { title: 'Toggle' }] }, NOW))
  expect(run.tasks.map(task => task.title)).toEqual(['Tokens', 'Toggle'])
  expect(run.taskList).toBe(1)
})

test('an add from a worker that has not seen the newest tasks fails and shows them', () => {
  const run = runOf(addTasks(working(), 'w1', { seen: 0, tasks: [{ title: 'Tokens' }] }, NOW))
  expect(addTasks(run, 'w2', { seen: 0, tasks: [{ title: 'Theme tokens' }] }, NOW)).toMatchObject({
    error: 'STALE_TASK_LIST',
    taskList: 1,
    tasks: [{ id: 1, title: 'Tokens' }],
  })
})

test('after a board read the worker adds what is missing', () => {
  const run = runOf(addTasks(working(), 'w1', { seen: 0, tasks: [{ title: 'Tokens' }] }, NOW))
  const read = boardFor(run, 'w2')
  const added = runOf(addTasks(read.run, 'w2', { seen: read.view.taskList, tasks: [{ title: 'Docs' }] }, NOW))
  expect(added.tasks.map(task => task.title)).toEqual(['Tokens', 'Docs'])
})

test('a worker that adds again uses the version its last add returned', () => {
  const first = addTasks(working(), 'w1', { seen: 0, tasks: [{ title: 'Tokens' }] }, NOW)
  expect(first).toMatchObject({ value: { taskList: 1 } })
  expect(runOf(addTasks(runOf(first), 'w1', { seen: 1, tasks: [{ title: 'Docs' }] }, NOW)).taskList).toBe(2)
})

test('claims and finished tasks do not change the task list version', () => {
  const claimed = runOf(claimTask(withTask(), 'w1', 1, 1, NOW))
  const done = runOf(finishTask(claimed, 'w1', 1, 2, 'def5678', 'Tokens added', NOW))
  expect(done.taskList).toBe(1)
})
