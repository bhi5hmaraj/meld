import { expect, test } from 'claude-code/testing'
import type { TurnUsage } from 'claude-code'

import { countStep, markWorker, recordActivity } from '../core/actions'
import { bindWorker, isFailure, saidOf, startRun } from '../core/board'
import type { Change, Run, WorkerId } from '../types'
import { FakeIo, HEAD } from './fake-io'

const NOW = 1_800_000_000_000
const USAGE = { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50 } as TurnUsage

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

function ioWithWorker(): FakeIo {
  const ids: WorkerId[] = ['w1']
  const workers = ids.map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: `meld/r1/${id}`, agent: { type: 'meld:worker' } }))
  const io = new FakeIo()
  io.current = runOf(bindWorker(startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers }), 'w1', 'agent-1', NOW))
  return io
}

test('the said of an agent is the first sentence of its text', () => {
  expect(saidOf('  I read the board. Next I claim #3.')).toBe('I read the board.')
  expect(saidOf('Plan\n\nI claim #3 now')).toBe('Plan')
  expect(saidOf('Tests pass!  Now the docs.')).toBe('Tests pass!')
})

test('a sentence of more than 20 words is cut to 20 words with an ellipsis', () => {
  const words = Array.from({ length: 25 }, (_, index) => `w${index + 1}`)
  expect(saidOf(`${words.join(' ')}.`)).toBe(`${words.slice(0, 20).join(' ')}...`)
  expect(saidOf(`${words.slice(0, 20).join(' ')}.`)).toBe(`${words.slice(0, 20).join(' ')}.`)
})

test('a text with no words gives no said', () => {
  expect(saidOf('')).toBeUndefined()
  expect(saidOf(' \n ')).toBeUndefined()
})

test('the answer of a model call of a worker becomes its said, with the time', async () => {
  const io = ioWithWorker()
  await countStep(io, 'agent-1', USAGE, undefined, 'I merged the line. Then the checks.')
  expect(io.current?.workers[0]).toMatchObject({ said: 'I merged the line.', saidAt: NOW, tokens: 350 })
})

test('a model call with no text keeps the said of the worker', async () => {
  const io = ioWithWorker()
  await countStep(io, 'agent-1', USAGE, undefined, 'I merged the line.')
  await countStep(io, 'agent-1', USAGE, undefined, '')
  await countStep(io, 'agent-1', USAGE)
  expect(io.current?.workers[0]?.said).toBe('I merged the line.')
})

test('the words of an ACP agent with its tool call, and at the end of its prompt, become the said of its worker', async () => {
  const io = ioWithWorker()
  await recordActivity(io, 'agent-1', 'Edit a.txt', 'I edit the greeting. It is short.')
  expect(io.current?.workers[0]).toMatchObject({ said: 'I edit the greeting.', saidAt: NOW, activity: 'Edit a.txt' })
  await markWorker(io, 'agent-1', 'idle', 0, 'Done with #2.')
  expect(io.current?.workers[0]).toMatchObject({ said: 'Done with #2.', state: 'idle' })
})
