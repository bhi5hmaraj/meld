import { expect, test } from 'claude-code/testing'

import { bindWorker, isFailure, startRun } from '../core/board'
import { TOOL } from '../core/contract'
import type { Run } from '../types'
import { HEAD } from './fake-io'

const NOW = 1_800_000_000_000
const UNANSWERED = 'clock.now'
const FIXED_BOARD = 'meld: the board failed. Try the call again.'
const FIXED_CONTROL = 'meld: the control of the run failed. Try the call again.'

function working(): Run {
  const started = startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers: [{ id: 'w1', path: '/tmp/meld/r1/w1', ref: 'meld/r1/w1', agent: { type: 'meld:worker' } }] })
  const bound = bindWorker(started, 'w1', 'agent-1', NOW)
  if (isFailure(bound)) throw new Error(bound.message)
  return bound.run
}

function stored(key: string) {
  return key === 'run' ? { value: { shape: 'run-5', value: working() }, version: 1 } : { value: undefined, version: 0 }
}

test('a board call that fails says why in its refusal', async ($, on) => {
  on('state.get', ($, e) => ({ value: stored(e.key) }))
  const replied = await $.tool.call({ tool: TOOL.note, input: { text: 'the tests need a database' }, agentId: 'agent-1' })
  const deny = 'deny' in replied ? replied.deny : ''
  expect(deny).toContain(UNANSWERED)
  expect(deny).not.toBe(FIXED_BOARD)
})

test('a control call that fails says why in its refusal', async ($, on) => {
  on('state.get', ($, e) => ({ value: stored(e.key) }))
  const replied = await $.tool.call({ tool: TOOL.stop, input: {} })
  const deny = 'deny' in replied ? replied.deny : ''
  expect(deny).toContain(UNANSWERED)
  expect(deny).not.toBe(FIXED_CONTROL)
})
