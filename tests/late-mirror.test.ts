import { expect, test } from 'claude-code/testing'

import { deliver, discard, markWorker, startRun } from '../hooks/actions'
import { bindWorker, declareFinal, isFailure, startRun as startBoard, stopRun, takeIntegration } from '../hooks/board'
import type { ProcessResult } from '../hooks/io'
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
 * final commit, can do. The end of its turn writes the run, and each write of the run mirrors the board. The files that
 * meld writes in the folder of the run after it removed the folder are in late.
 */
class LateStepIo extends FakeIo {
  removed = false
  late: string[] = []

  override async run(argv: string[], cwd: string): Promise<ProcessResult> {
    const ran = await super.run(argv, cwd)
    if (argv.join(' ') === REMOVE_HOME) {
      this.removed = true
      await markWorker(this, 'agent-1', 'idle', 100)
    }
    return ran
  }

  override async writeFile(path: string, text: string): Promise<void> {
    if (this.removed && path.startsWith(`${HOME}/`)) this.late.push(path)
    await super.writeFile(path, text)
  }
}

function ioWith(run: Run): LateStepIo {
  const io = new LateStepIo()
  io.current = run
  return io
}

test('Deliver marks the run delivered before it removes the folder, so a worker that ends its turn then writes no board.json there', async () => {
  const io = ioWith(ready())
  expect(await deliver(io)).toBe(`Merged ${FULL.slice(0, 7)} into your branch.`)
  expect(io.removed).toBe(true)
  expect(io.late).toEqual([])
  expect(io.current?.state).toBe('delivered')
})

test('Deliver on jj marks the run delivered before it removes the folder', async () => {
  const io = ioWith(ready('jj'))
  expect(await deliver(io)).toBe(`Merged ${FULL.slice(0, 7)} into your branch.`)
  expect(io.removed).toBe(true)
  expect(io.late).toEqual([])
  expect(io.current?.state).toBe('delivered')
})

test('Discard clears the run before it removes the folder, so a worker that ends its turn then writes no board.json there', async () => {
  const io = ioWith(working())
  expect(await discard(io)).toBe('The run and its workspaces are gone.')
  expect(io.removed).toBe(true)
  expect(io.late).toEqual([])
  expect(io.current).toBeNull()
  expect(io.facts).toBeNull()
})

test('Discard of a stopped jj run clears the run before it removes the folder', async () => {
  const io = ioWith(stopRun(working('jj'), NOW))
  expect(await discard(io)).toBe('The run and its workspaces are gone.')
  expect(io.removed).toBe(true)
  expect(io.late).toEqual([])
  expect(io.current).toBeNull()
})

test('a start over a stopped run with no work clears that run before it removes its folder', async () => {
  const io = ioWith(stopRun(working(), NOW))
  const result = await startRun(io, '/repo', { request: 'More', agents: [WORKER, WORKER], vcs: 'git' })
  expect(io.removed).toBe(true)
  expect(io.late).toEqual([])
  expect(io.current?.id).toBe(NOW.toString(36))
  expect(result.text).toBe(`Run ${NOW.toString(36)}: 2 workers on git, from commit ${HEAD.slice(0, 7)}.`)
})
