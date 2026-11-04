import { expect, test } from 'claude-code/testing'

import { deliver, deliveryMessage } from '../hooks/actions'
import { bindWorker, declareFinal, isFailure, startRun, takeIntegration } from '../hooks/board'
import type { Change, Run } from '../types'
import { FakeIo, HEAD } from './fake-io'

const NOW = 1_800_000_000_000
const FULL = 'f'.repeat(40)
const REQUEST = 'Add a dark theme with a toggle in the header\n\nKeep the colours of the brand, and test both themes.'

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

function ready(summary: string, request = REQUEST): Run {
  const workers = [{ id: 'w1' as const, path: '/tmp/meld/r1/w1', ref: 'meld/r1/w1', agent: { type: 'meld:worker' } }]
  const run = runOf(bindWorker(startRun({ id: 'r1', request, repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers }), 'w1', 'agent-1', NOW))
  return runOf(declareFinal(runOf(takeIntegration(run, 'w1', NOW)), 'w1', FULL, summary, NOW))
}

test('the merge commit of a delivery says meld and the summary of the final commit, and its body holds the full request', () => {
  expect(deliveryMessage(ready('A dark theme and a toggle, with tests'))).toBe(`meld: A dark theme and a toggle, with tests\n\n${REQUEST}`)
})

test('with no summary, the subject is the first line of the request', () => {
  expect(deliveryMessage(ready('  ')).split('\n')[0]).toBe('meld: Add a dark theme with a toggle in the header')
})

test('a long subject is cut at its last space, so that it has 72 characters at most', () => {
  const summary = 'A dark theme with a toggle in the header, the colours of the brand, and tests of both themes'
  const subject = deliveryMessage(ready(summary)).split('\n')[0] ?? ''
  expect(subject).toBe('meld: A dark theme with a toggle in the header, the colours of the')
  expect(subject.length).toBeLessThanOrEqual(72)
})

test('a subject of one long word is cut at 72 characters', () => {
  const subject = deliveryMessage(ready('x'.repeat(100))).split('\n')[0] ?? ''
  expect(subject).toBe(`meld: ${'x'.repeat(66)}`)
})

test('deliver merges with that message', async () => {
  const io = new FakeIo()
  io.current = ready('A dark theme')
  await deliver(io)
  expect(io.commands).toContain(`git merge --no-ff -m meld: A dark theme\n\n${REQUEST} ${FULL}`)
})
