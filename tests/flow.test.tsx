import { expect, test } from 'claude-code/testing'

import { addTasks, addUsage, bindWorker, claimTask, finishTask, isFailure, machineSlept, setWorkerState, startRun } from '../core/board'
import { FLOW_SHAPE } from '../hooks/drawing'
import type { Change, Run, WorkerId } from '../types'

const NOW = 1_800_000_000_000
const MINUTE = 60_000
const START = NOW - 30 * MINUTE
const BASE = 'a'.repeat(40)
const FULL = 'f'.repeat(40)
const USAGE = { input: 200_000, cacheWrite: 0, cacheRead: 4_000_000, output: 80_000 }
const PANE = {
  plugin: 'meld',
  component: 'Pane',
  requestId: 'meld',
  props: { title: 'meld', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const
const ALL_SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const { working, waiting, idle, asleep } = FLOW_SHAPE
const W1_CELLS = `w1 ${working.repeat(15)}${idle.repeat(3)}${asleep.repeat(6)}${idle.repeat(6)}`
const W2_CELLS = `w2 ${waiting.repeat(6)}${working.repeat(12)}${asleep.repeat(6)}${working.repeat(6)}`
const W1_ALT = 'w1: working on #1 15m, idle 3m, asleep 6m, idle 6m'
const W2_ALT = 'w2: waiting on meld 6m, working on #2 12m, asleep 6m, working on #2 6m'
const METRICS = 'busy 55%; ready with no agent 6m; task time 15m; 1.0M tokens per finished task'

type SvgNode = { type: string; props: { alt: string; source: string } }

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

function stored(run: Run, key: string) {
  return key === 'run' ? { value: { shape: 'run-5', value: run }, version: 1 } : { value: undefined, version: 0 }
}

function started(ids: WorkerId[], at: number): Run {
  const workers = ids.map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: `meld/r1/${id}`, agent: { type: 'meld:worker' } }))
  const run = startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: BASE, vcs: 'git', now: at, workers })
  const bound = ids.reduce((current, id, index) => runOf(bindWorker(current, id, `agent-${index + 1}`, at)), run)
  return runOf(addTasks(bound, 'w1', { seen: 0, tasks: [{ title: 'Theme tokens' }, { title: 'Dark toggle' }] }, at))
}

/** 30 minutes: w1 does #1 in 15, w2 waits 6 for the ready #2 and then does it, and the machine sleeps from minute 18 to 24. */
function flowRun(): Run {
  const sixth = START + 6 * MINUTE
  const fifteenth = START + 15 * MINUTE
  const w1Claims = runOf(claimTask(started(['w1', 'w2'], START), 'w1', 1, 1, START))
  const w2Claims = runOf(claimTask(setWorkerState(setWorkerState(w1Claims, 'w2', 'idle', START), 'w2', 'working', sixth), 'w2', 2, 1, sixth))
  const w1Done = setWorkerState(runOf(finishTask(w2Claims, 'w1', 1, 2, FULL, 'Tokens', fifteenth)), 'w1', 'idle', fifteenth)
  return addUsage(machineSlept(w1Done, START + 18 * MINUTE, START + 24 * MINUTE), 'w1', USAGE)
}

test('the terminal draws one row of cells for each worker in Flow, one shape for each kind of part', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: stored(flowRun(), e.key) }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'flow-w1' }))?.text).toBe(W1_CELLS)
  expect((await ui.find({ key: 'flow-w2' }))?.text).toBe(W2_CELLS)
  await ui.unmount()
})

test('a graphic surface draws each lane of Flow as a picture, with its parts in words', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: stored(flowRun(), e.key) }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const w1 = (await ui.find({ key: 'flow-w1' }))?.children?.at(-1) as SvgNode | undefined
  const w2 = (await ui.find({ key: 'flow-w2' }))?.children?.at(-1) as SvgNode | undefined
  expect(w1?.type).toBe('Svg')
  expect(w1?.props.alt).toBe(W1_ALT)
  expect(w1?.props.source).toContain('<title>asleep</title>')
  expect(w2?.props.alt).toBe(W2_ALT)
  await ui.unmount()
})

test('Flow gives busy share, ready with no agent, task time and cost per finished task, the same on every surface', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: stored(flowRun(), e.key) }))
  for (const surface of ALL_SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: METRICS }), surface).toBeDefined()
    await ui.unmount()
  }
})

test('Flow shows the last 30 minutes of a longer run, where w1 waits for the ready #2', async ($, on) => {
  const early = NOW - 60 * MINUTE
  const fortieth = early + 40 * MINUTE
  const run = setWorkerState(runOf(finishTask(runOf(claimTask(started(['w1'], early), 'w1', 1, 1, early)), 'w1', 1, 2, FULL, 'Tokens', fortieth)), 'w1', 'idle', fortieth)
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: stored(run, e.key) }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'flow-w1' }))?.text).toBe(`w1 ${working.repeat(10)}${waiting.repeat(20)}`)
  expect(await ui.find({ type: 'Text', text: 'last 30m' })).toBeDefined()
  await ui.unmount()
})
