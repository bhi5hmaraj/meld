import { expect, test } from 'claude-code/testing'

import { bindWorker, isFailure, startRun } from '../hooks/board'
import { HAND_BACK, workerRules } from '../hooks/contract'
import type { Change, Run } from '../types'
import { HEAD } from './fake-io'

const NOW = 1_800_000_000_000

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

function working(): Run {
  const workers = [{ id: 'w1' as const, path: '/tmp/meld/r1/w1', ref: 'w1@', agent: { type: 'meld:worker' } }]
  return runOf(bindWorker(startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'jj', now: NOW, workers }), 'w1', 'agent-1', NOW))
}

test('the rules ask for a report of one line at the end of each turn, as the board keeps the detail', () => {
  const rules = workerRules(working(), 'w1')
  expect(rules).toContain('End each turn with one line, for example: finished #4, commit 4a0bde04.')
  expect(rules).toContain('The board keeps the detail')
  expect(rules).not.toContain('short report')
})

test('the reply of finish_task asks for a hand back with one line', () => {
  expect(HAND_BACK).toContain('Hand back now with one line, for example: finished #4, commit 4a0bde04.')
})
