import { expect, test } from 'claude-code/testing'

import { addTasks, bindWorker, isFailure, startRun, steer } from '../hooks/board'
import type { Change, Run } from '../types'

const NOW = 1_800_000_000_000
const PANE = {
  plugin: 'meld',
  component: 'Pane',
  requestId: 'meld',
  props: { title: 'meld', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const
const INPUT_SURFACES = ['terminal', 'desktop', 'vscode'] as const
const ALL_SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

function storedRun(): { value: { shape: string; value: Run }; version: number } {
  const workers = [
    { path: '/tmp/meld/r1/w1', branch: 'meld/r1/w1' },
    { path: '/tmp/meld/r1/w2', branch: 'meld/r1/w2' },
  ]
  const fresh = startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: 'abc1234def', now: NOW, workers })
  const bound = runOf(bindWorker(runOf(bindWorker(fresh, 'w1', 'agent-1', NOW)), 'w2', 'agent-2', NOW))
  const run = runOf(steer(runOf(addTasks(bound, 'w1', { seen: 0, tasks: [{ title: 'Theme tokens' }] }, NOW)), 'Use the brand colours', NOW))
  return { value: { shape: 'run-3', value: run }, version: 1 }
}

test('the pane draws a run on every surface', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('state.get', () => ({ value: storedRun() }))
  for (const surface of ALL_SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Add a dark theme/ }))?.text).toBe('Add a dark theme')
    expect(await ui.find({ type: 'Text', text: /steer 1: Use the brand colours/ })).toBeDefined()
    expect(await ui.find({ key: 'stop-w1' })).toBeDefined()
    await ui.unmount()
  }
})

test('the pane has a steer field where the surface takes input', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('state.get', () => ({ value: storedRun() }))
  for (const surface of INPUT_SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'steer' })).toBeDefined()
    await ui.unmount()
  }
})

test('the pane on mobile shows the steer command', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('state.get', () => ({ value: storedRun() }))
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect((await ui.find({ type: 'Text', text: /^To steer/ }))?.text).toBe('To steer, send /meld-steer followed by the instruction.')
  await ui.unmount()
})

test('the pane with no run tells how to start one', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /No run/ }))?.text).toBe('No run. Start one with /meld followed by the task.')
  await ui.unmount()
})
