import { expect, test } from 'claude-code/testing'

import { addTasks, addUsage, bindWorker, claimTask, finishTask, isFailure, machineSlept, setWorkerState, startRun, stopRun } from '../core/board'
import { FLOW_SHAPE } from '../core/report'
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
const { working, waiting, idle, asleep } = FLOW_SHAPE
const W1_CELLS = `w1 ${working.repeat(15)}${idle.repeat(3)}${asleep.repeat(6)}${idle.repeat(6)}`
const W2_CELLS = `w2 ${waiting.repeat(6)}${working.repeat(12)}${asleep.repeat(6)}${working.repeat(6)}`
const W1_ALT = 'w1: working on #1 15m, idle 3m, asleep 6m, idle 6m'
const W2_ALT = 'w2: waiting on meld 6m, working on #2 12m, asleep 6m, working on #2 6m'
const AXIS = `   0m${' '.repeat(8)}10m${' '.repeat(7)}20m${' '.repeat(4)}30m`

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

/** 30 minutes: w1 does #1 in 15, w2 waits 6 for the ready #2 and then does it, the machine sleeps from minute 18 to 24, and the person stops the run. */
function flowRun(): Run {
  const sixth = START + 6 * MINUTE
  const fifteenth = START + 15 * MINUTE
  const w1Claims = runOf(claimTask(started(['w1', 'w2'], START), 'w1', 1, 1, START))
  const w2Claims = runOf(claimTask(setWorkerState(setWorkerState(w1Claims, 'w2', 'idle', START), 'w2', 'working', sixth), 'w2', 2, 1, sixth))
  const w1Done = setWorkerState(runOf(finishTask(w2Claims, 'w1', 1, 2, FULL, 'Tokens', fifteenth)), 'w1', 'idle', fifteenth)
  return stopRun(addUsage(machineSlept(w1Done, START + 18 * MINUTE, START + 24 * MINUTE), 'w1', USAGE), NOW)
}

test('the terminal draws one row of cells for each worker in the report, one shape for each kind of part, over an axis of minutes', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: stored(flowRun(), e.key) }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'flow-w1' }))?.text).toBe(W1_CELLS)
  expect((await ui.find({ key: 'flow-w2' }))?.text).toBe(W2_CELLS)
  expect(await ui.find({ type: 'Text', text: AXIS })).toBeDefined()
  await ui.unmount()
})

test('a graphic surface draws each lane of the report as a picture, with its parts in words', async ($, on) => {
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

test('a working run shows no lanes: they live in the report', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: stored(runOf(claimTask(started(['w1'], START), 'w1', 1, 1, START)), e.key) }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'flow-w1' })).toBeUndefined()
  await ui.unmount()
})
