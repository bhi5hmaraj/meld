import { expect, test } from 'claude-code/testing'

import { steerRun } from '../hooks/actions'
import { bindWorker, isFailure, setWorkerState, startRun, stopWorker } from '../hooks/board'
import type { Change, Run, WorkerId, WorkerState } from '../types'
import { FakeIo, HEAD } from './fake-io'

const NOW = 1_800_000_000_000

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

/** A run whose workers are in the given states, in order w1, w2, w3. */
function runWith(states: WorkerState[]): FakeIo {
  const ids = (['w1', 'w2', 'w3'] as WorkerId[]).slice(0, states.length)
  const workers = ids.map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: `meld/r1/${id}`, agent: { type: 'meld:worker' } }))
  let run = startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers })
  for (const [index, id] of ids.entries()) run = runOf(bindWorker(run, id, `agent-${index + 1}`, NOW))
  for (const [index, state] of states.entries()) {
    const id = ids[index] as WorkerId
    if (state === 'stopped') run = stopWorker(run, id, NOW)
    else if (state !== 'working') run = setWorkerState(run, id, state, NOW)
  }
  const io = new FakeIo()
  io.current = run
  return io
}

test('a steer of one running worker says worker, not workers', async () => {
  expect(await steerRun(runWith(['working']), 'Use the brand colours')).toBe('The worker gets revision 2.')
})

test('a steer of one running worker and one ended worker counts each in the singular', async () => {
  expect(await steerRun(runWith(['working', 'idle']), 'Use the brand colours')).toBe(
    'Revision 2: 1 running worker gets it; the other sees it when meld starts it again.',
  )
})

test('a steer of one running worker and two ended workers says the others', async () => {
  expect(await steerRun(runWith(['idle', 'working', 'idle']), 'Use the brand colours')).toBe(
    'Revision 2: 1 running worker gets it; the others see it when meld starts them again.',
  )
})

test('a steer of two running workers and one ended worker says the other', async () => {
  expect(await steerRun(runWith(['working', 'working', 'idle']), 'Use the brand colours')).toBe(
    'Revision 2: 2 running workers get it; the other sees it when meld starts it again.',
  )
})

test('a steer of three running workers says all 3 workers', async () => {
  expect(await steerRun(runWith(['working', 'working', 'working']), 'Use the brand colours')).toBe('All 3 workers get revision 2.')
})

test('a steer with every worker stopped says that no worker is left, not all 0 workers', async () => {
  expect(await steerRun(runWith(['stopped', 'stopped']), 'Use the brand colours')).toBe('Revision 2: no worker is left to take it.')
})
