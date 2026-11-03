import { expect, test } from 'claude-code/testing'

import { startRun } from '../hooks/board'
import { TOOL, workerPrompt, workerRules } from '../hooks/contract'
import type { Run, VcsKind, WorkerId } from '../types'

const IDS: WorkerId[] = ['w1', 'w2', 'w3']

function runOn(vcs: VcsKind, count = 2): Run {
  const ref = (id: WorkerId) => (vcs === 'jj' ? `${id}@` : `meld/r1/${id}`)
  const workers = IDS.slice(0, count).map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: ref(id), agent: { type: 'meld:worker' } }))
  return startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: 'abc1234def', vcs, now: 0, workers })
}

test('the rules of a git run name the branches of the other workers and git merge', () => {
  const rules = workerRules(runOn('git'), 'w1')
  expect(rules).toContain('You are w1')
  expect(rules).toContain('meld/r1/w2')
  expect(rules).toContain('git merge')
})

test('the rules of a jj run use jj commit and the last commits of the other workers', () => {
  const rules = workerRules(runOn('jj'), 'w1')
  expect(rules).toContain('jj commit -m')
  expect(rules).toContain('w2@-')
  expect(rules).not.toContain('git merge')
})

test('the rules name every other worker', () => {
  const rules = workerRules(runOn('git', 3), 'w2')
  expect(rules).toContain('w1 (meld/r1/w1)')
  expect(rules).toContain('w3 (meld/r1/w3)')
})

test('the spawn prompt holds the request and sends the worker to the board first', () => {
  const prompt = workerPrompt(runOn('git'), 'w2')
  expect(prompt).toContain('Add a dark theme')
  expect(prompt).toContain(TOOL.board)
  expect(prompt).toContain('w2')
})
