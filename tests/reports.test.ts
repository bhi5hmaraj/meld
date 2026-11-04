import { expect, test } from 'claude-code/testing'

import { markWorker, restartIdleWorkers } from '../hooks/actions'
import { addTasks, bindWorker, isFailure, startRun } from '../hooks/board'
import { HAND_BACK, WORKER_SYSTEM, workerPrompt, workerRules } from '../hooks/contract'
import type { Change, Run } from '../types'
import { FakeIo, HEAD } from './fake-io'

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

const LAST_LINE = 'Your last message goes to the session of the person. Make it one line, for example: finished #4, commit 4a0bde04. The board keeps the detail.'

test('the system prompt of the meld:worker agent asks for a last message of one line', () => {
  expect(WORKER_SYSTEM).toContain(LAST_LINE)
})

test('the spawn prompt ends with the ask for a last message of one line', () => {
  const prompt = workerPrompt(working(), 'w1')
  expect(prompt).toContain('Add a dark theme')
  expect(prompt.endsWith(LAST_LINE)).toBe(true)
})

test('a restart puts what meld asks before the ask for one line, so the spawn prompt still ends with it', async () => {
  const run = working()
  const io = new FakeIo()
  io.current = runOf(addTasks(run, 'w1', { seen: run.taskList, tasks: [{ title: 'Tokens' }] }, NOW))
  await markWorker(io, 'agent-1', 'idle')
  await restartIdleWorkers(io)
  const prompt = io.spawned[0]?.prompt ?? ''
  expect(prompt).toContain('What meld asks of you now: meld: These tasks are open: #1 Tokens. Claim one and do it.')
  expect(prompt.endsWith(LAST_LINE)).toBe(true)
})
