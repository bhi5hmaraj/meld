import { expect, test } from 'claude-code/testing'

import { deliver, deliveryMessage, discard } from '../core/actions'
import { bindWorker, declareFinal, isFailure, startRun, takeIntegration } from '../core/board'
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

const KEPT_FILES = 'The workspaces stay in /tmp/meld/r1, with every file that the agents left there: /meld-discard removes them.'

test('Deliver keeps the workspaces, with the files that no commit holds, and says where they are and how to remove them', async () => {
  const io = new FakeIo()
  io.current = ready('A dark theme')
  expect(await deliver(io)).toBe(`Merged ${FULL.slice(0, 7)} into your branch. ${KEPT_FILES}`)
  expect(io.ran('rm -rf -- /tmp/meld/r1')).toBe(false)
  expect(io.ran('git worktree remove')).toBe(false)
})

test('a second Deliver while one runs merges nothing and says that the delivery is going on', async () => {
  const io = new FakeIo()
  io.current = ready('A dark theme')
  const replies = await Promise.all([deliver(io), deliver(io)])
  expect(replies).toEqual([`Merged ${FULL.slice(0, 7)} into your branch. ${KEPT_FILES}`, 'Run r1 is being delivered now: wait for that delivery to end.'])
  expect(io.commands.filter(command => command.startsWith('git merge')).length).toBe(1)
})

test('a Deliver after the delivery says that the run is delivered, with its commit', async () => {
  const io = new FakeIo()
  io.current = ready('A dark theme')
  await deliver(io)
  expect(await deliver(io)).toBe(`Run r1 is delivered: ${FULL.slice(0, 7)} is in your branch.`)
})

test('Discard after Deliver removes the workspaces that Deliver kept', async () => {
  const io = new FakeIo()
  io.current = ready('A dark theme')
  await deliver(io)
  expect(await discard(io)).toBe('The run and its workspaces are gone.')
  expect(io.ran('rm -rf -- /tmp/meld/r1')).toBe(true)
})
