import { expect, test } from 'claude-code/testing'

import { deliver, discard, markWorker, startRun } from '../core/actions'
import { bindWorker, declareFinal, isFailure, startRun as startBoard, stopRun, takeIntegration } from '../core/board'
import type { ProcessResult } from '../core/ports'
import type { AgentSpec, Change, Run, VcsKind, WorkerId } from '../types'
import { FakeIo, HEAD } from './fake-io'

const NOW = 1_800_000_000_000
const FULL = 'f'.repeat(40)
const HOME = '/tmp/meld/r1'
const REMOVE_HOME = `rm -rf -- ${HOME}`
const WORKER: AgentSpec = { type: 'meld:worker' }

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

/** Two workers at work, with the agents agent-1 and agent-2. */
function working(vcs: VcsKind = 'git'): Run {
  const ids: WorkerId[] = ['w1', 'w2']
  const workers = ids.map(id => ({ id, path: `${HOME}/${id}`, ref: vcs === 'jj' ? `${id}@` : `meld/r1/${id}`, agent: WORKER }))
  let run = startBoard({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs, now: NOW, workers })
  for (const [index, id] of ids.entries()) run = runOf(bindWorker(run, id, `agent-${index + 1}`, NOW))
  return run
}

/** The run of working(), ready with the final commit FULL of w2. */
function ready(vcs: VcsKind = 'git'): Run {
  return runOf(declareFinal(runOf(takeIntegration(working(vcs), 'w2', NOW)), 'w2', FULL, 'A dark theme', NOW))
}

/**
 * w1 ends its turn while meld removes the folder of the run, as a worker that meld told to stop, or that ends after the
 * final commit, can do. The run that the store holds when the removal starts is in atRemoval: a run that is still live
 * then can get a new agent in a folder that is going away.
 */
class RemovalIo extends FakeIo {
  atRemoval: Run | null | undefined = undefined

  override async run(argv: string[], cwd: string): Promise<ProcessResult> {
    if (argv.join(' ') === REMOVE_HOME) {
      this.atRemoval = this.current
      await markWorker(this, 'agent-1', 'idle', 100)
    }
    return super.run(argv, cwd)
  }
}

function ioWith(run: Run): RemovalIo {
  const io = new RemovalIo()
  io.current = run
  return io
}

test('Deliver marks the run delivered before it removes the folder, and a worker that ends its turn then changes nothing', async () => {
  const io = ioWith(ready())
  expect(await deliver(io)).toBe(`Merged ${FULL.slice(0, 7)} into your branch.`)
  expect(io.atRemoval?.state).toBe('delivered')
  expect(io.current?.state).toBe('delivered')
})

test('Deliver on jj marks the run delivered before it removes the folder', async () => {
  const io = ioWith(ready('jj'))
  expect(await deliver(io)).toBe(`Merged ${FULL.slice(0, 7)} into your branch.`)
  expect(io.atRemoval?.state).toBe('delivered')
})

test('Discard clears the run and its facts before it removes the folder, and a worker that ends its turn then writes no run', async () => {
  const io = ioWith(working())
  expect(await discard(io)).toBe('The run and its workspaces are gone.')
  expect(io.atRemoval).toBeNull()
  expect(io.current).toBeNull()
  expect(io.facts).toBeNull()
})

test('Discard of a stopped jj run clears the run before it removes the folder', async () => {
  const io = ioWith(stopRun(working('jj'), NOW))
  expect(await discard(io)).toBe('The run and its workspaces are gone.')
  expect(io.atRemoval).toBeNull()
})

test('a start over a stopped run with no work clears that run before it removes its folder', async () => {
  const io = ioWith(stopRun(working(), NOW))
  const result = await startRun(io, '/repo', { request: 'More', agents: [WORKER, WORKER], vcs: 'git' })
  expect(io.atRemoval).toBeNull()
  expect(io.current?.id).toBe(`${NOW.toString(36)}0000`)
  expect(result.text).toBe(`Run ${NOW.toString(36)}0000: 2 workers on git, from commit ${HEAD.slice(0, 7)}.`)
})
