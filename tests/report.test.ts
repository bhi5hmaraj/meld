import { expect, test } from 'claude-code/testing'

import { addCheck, addTasks, bindWorker, boardFor, claimTask, declareFinal, finishTask, isFailure, setWorkerState, shareEntry, startRun, steer, takeIntegration } from '../core/board'
import { discard } from '../core/actions'
import { FLOW_SHAPE, reportCommand, reportOf } from '../core/report'
import type { Change, Run, WorkerId } from '../types'
import { ARCHIVE, FakeIo } from './fake-io'

const NOW = 1_800_000_000_000
const MINUTE = 60_000
const START = NOW - 40 * MINUTE
const BASE = 'a'.repeat(40)
const FULL = 'f'.repeat(40)
const OTHER = 'e'.repeat(40)
const STORY = '2 agents finished 2 tasks in 40 minutes. For 20 of those minutes, only one agent worked. w1 did 50% of the work. 1 of 1 entries reached another agent. 1 of 2 checks failed, and the person did not steer.'
const EMPTY_STORY = '2 agents finished 0 tasks in 40 minutes. For 0 of those minutes, only one agent worked. No agent finished a task. No agent shared an entry. No check ran, and the person steered 1 time.'
const TIME_LINE = 'Time: 40m of run, 80m of agent time, busy 75%, parallelism 1.5, one agent alone 20m, waiting on meld 0m, asleep 0m, idle restarts 0.'
const W1_LINE = 'w1: busy 20m of 40m, 50% of the work, 20m idle while others worked, 0 tokens.'
const ARCHIVED = `${ARCHIVE}/r1.json`
const RUNS_ROW = '| r1 | 2 | 2 | 40m | 75% | 20m | 0m | 0.75 |'
const { working, idle } = FLOW_SHAPE
const ALL_SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const PANE = {
  plugin: 'meld',
  component: 'Pane',
  requestId: 'meld',
  props: { title: 'meld', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

function started(ids: WorkerId[]): Run {
  const workers = ids.map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: `meld/r1/${id}`, agent: { type: 'meld:worker' } }))
  const run = startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: BASE, vcs: 'git', now: START, workers })
  const bound = ids.reduce((current, id, index) => runOf(bindWorker(current, id, `agent-${index + 1}`, START)), run)
  return runOf(addTasks(bound, 'w1', { seen: 0, tasks: [{ title: 'Theme tokens' }, { title: 'Dark toggle' }] }, START))
}

/** 40 minutes: w1 does #1 in 20 and shares a fact that w2 reads, w2 does #2 in 40 with one failed check, then integrates. */
function reportRun(): Run {
  const claimed = runOf(claimTask(runOf(claimTask(started(['w1', 'w2']), 'w1', 1, 1, START)), 'w2', 2, 1, START))
  const shared = boardFor(runOf(shareEntry(claimed, 'w1', { kind: 'fact', text: 'The tokens live in theme.css' }, START + 5 * MINUTE)), 'w2', START + 6 * MINUTE).run
  const w1Done = setWorkerState(runOf(finishTask(shared, 'w1', 1, 2, FULL, 'Tokens', START + 20 * MINUTE)), 'w1', 'idle', START + 20 * MINUTE)
  const checked = runOf(addCheck(runOf(addCheck(w1Done, 'w2', { command: 'bun test', commit: OTHER, passed: false, output: '' }, START + 30 * MINUTE)), 'w2', { command: 'bun test', commit: OTHER, passed: true, output: '' }, START + 39 * MINUTE))
  const w2Done = runOf(finishTask(checked, 'w2', 2, 2, OTHER, 'Toggle', NOW))
  return runOf(declareFinal(runOf(takeIntegration(w2Done, 'w2', NOW)), 'w2', OTHER, 'A dark theme', NOW))
}

test('the story of a run gives its agents, tasks, time, the time of one agent alone, the share of the top worker, deliveries, checks and steers', () => {
  expect(reportOf(reportRun(), NOW).story).toBe(STORY)
})

test('the story of a run with no finished task, no entry and no check says so, and counts the steers', () => {
  expect(reportOf(runOf(steer(started(['w1', 'w2']), 'Use the old colours', START)), NOW).story).toBe(EMPTY_STORY)
})

test('the report gives the time metrics of the run in one line', () => {
  expect(reportOf(reportRun(), NOW).run[0]).toBe(TIME_LINE)
})

test('the report gives one line for each worker: busy time, share of the work, idle time while others worked, and cost', () => {
  expect(reportOf(reportRun(), NOW).workers[0]).toBe(W1_LINE)
})

test('/meld-report gives the report of the run of the session, with its lanes in cells', async () => {
  const io = new FakeIo()
  io.current = reportRun()
  const text = await reportCommand(io, '')
  expect(text).toContain(STORY)
  expect(text).toContain(`w1 ${working.repeat(15)}${idle.repeat(15)}`)
  expect(text).toContain(W1_LINE)
})

test('Discard writes the report into the archive of the run', async () => {
  const io = new FakeIo()
  io.current = reportRun()
  await discard(io)
  expect(JSON.parse(io.files[ARCHIVED] ?? '{}').report).toContain(STORY)
})

test('/meld-report with the id of an archived run gives its report', async () => {
  const io = new FakeIo()
  io.current = reportRun()
  await discard(io)
  expect(await reportCommand(io, 'r1')).toContain(STORY)
})

test('/meld-report with the id of a run that meld did not archive says so', async () => {
  expect(await reportCommand(new FakeIo(), 'r9')).toBe('meld has no archived run r9.')
})

test('/meld-report --runs gives one row for each archived run', async () => {
  const io = new FakeIo()
  io.current = reportRun()
  await discard(io)
  io.listings[ARCHIVE] = [{ name: 'r1.json', kind: 'file', mtimeMs: 1 }]
  expect(await reportCommand(io, '--runs')).toContain(RUNS_ROW)
})

test('a ready run shows the report in place of Flow, the same on every surface', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: e.key === 'run' ? { value: { shape: 'run-5', value: reportRun() }, version: 1 } : { value: undefined, version: 0 } }))
  for (const surface of ALL_SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: STORY }), surface).toBeDefined()
    expect(await ui.find({ type: 'Text', text: TIME_LINE }), surface).toBeDefined()
    expect(await ui.find({ type: 'Text', text: W1_LINE }), surface).toBeDefined()
    expect(await ui.find({ key: 'flow-w1' }), surface).toBeDefined()
    expect(await ui.find({ key: 'sec-flow' }), surface).toBeUndefined()
    await ui.unmount()
  }
})
