import { expect, test } from 'claude-code/testing'

import { startRun } from '../core/actions'
import { bindWorker, isFailure, startRun as startBoard, stopRun } from '../core/board'
import type { AgentSpec, Change, Run, WorkerId } from '../types'
import { FakeIo, HEAD } from './fake-io'

const NOW = 1_800_000_000_000
const ID = `${NOW.toString(36)}0000`
const WORKER: AgentSpec = { type: 'meld:worker' }
const TWO = [WORKER, WORKER]
const STARTED = `Run ${ID}: 2 workers on git, from commit ${HEAD.slice(0, 7)}.`

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

/** A run r1 of two workers that stopped, with no work in its workspaces. */
function stopped(): Run {
  const ids: WorkerId[] = ['w1', 'w2']
  const workers = ids.map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: `meld/r1/${id}`, agent: WORKER }))
  let run = startBoard({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers })
  for (const [index, id] of ids.entries()) run = runOf(bindWorker(run, id, `agent-${index + 1}`, NOW))
  return stopRun(run, NOW)
}

/** A session whose git prints `printed` for git version. */
function gitPrints(printed: string): FakeIo {
  const io = new FakeIo()
  io.answers['git version'] = printed
  return io
}

/** The refusal of a start with git `version`. */
function tooOld(version: string): string {
  return `meld needs git 2.38 or newer for git merge-tree --write-tree, which merges each finished task into the integration line. This git is ${version}. Update git, then start again.`
}

test('a start with git older than 2.38 refuses, names the version and the need, and makes no workspace', async () => {
  const io = gitPrints('git version 2.37.1')
  const result = await startRun(io, '/repo', { request: 'Add a dark theme', agents: TWO, vcs: 'git' })
  expect(result.text).toBe(tooOld('2.37.1'))
  expect(io.ran('git worktree')).toBe(false)
  expect(io.spawned).toHaveLength(0)
  expect(io.current).toBeNull()
})

test('a start on jj with git older than 2.38 refuses too, as the line of a jj run merges with git', async () => {
  const io = gitPrints('git version 2.34.1')
  io.answers['jj --version'] = 'jj 0.46.0'
  const result = await startRun(io, '/repo', { request: 'Add a dark theme', agents: TWO, vcs: 'auto' })
  expect(result.text).toBe(tooOld('2.34.1'))
  expect(io.ran('jj')).toBe(false)
  expect(io.current).toBeNull()
})

test('a start with git older than 2.38 names the version without the suffix of a vendor build', async () => {
  const io = gitPrints('git version 2.37.1 (Apple Git-137.1)')
  expect((await startRun(io, '/repo', { request: 'Add a dark theme', agents: TWO, vcs: 'git' })).text).toBe(tooOld('2.37.1'))
})

test('a refused start with git older than 2.38 keeps a stopped run and its workspaces', async () => {
  const io = gitPrints('git version 1.8.3.1')
  io.current = stopped()
  const result = await startRun(io, '/repo', { request: 'More', agents: TWO, vcs: 'git' })
  expect(result.text).toBe(tooOld('1.8.3.1'))
  expect(io.ran('git worktree')).toBe(false)
  expect(io.ran('rm')).toBe(false)
  expect(io.current).toMatchObject({ id: 'r1', state: 'stopped' })
})

test('a start goes on with git 2.38 or newer, as plain, Apple and Windows builds print it', async () => {
  for (const printed of ['git version 2.38.0', 'git version 2.39.5 (Apple Git-154)', 'git version 2.47.1.windows.2', 'git version 3.0.0']) {
    const io = gitPrints(printed)
    expect((await startRun(io, '/repo', { request: 'Add a dark theme', agents: TWO, vcs: 'git' })).text).toBe(STARTED)
  }
})

test('a start goes on when git version fails', async () => {
  const io = new FakeIo()
  io.failing = ['git version']
  expect((await startRun(io, '/repo', { request: 'Add a dark theme', agents: TWO, vcs: 'git' })).text).toBe(STARTED)
  expect(io.ran('git version')).toBe(true)
})

test('a start goes on when git version prints no version', async () => {
  const io = gitPrints('git: a wrapper with no version')
  expect((await startRun(io, '/repo', { request: 'Add a dark theme', agents: TWO, vcs: 'git' })).text).toBe(STARTED)
})

test('a start reads the version of git only when no run is active', async () => {
  const io = gitPrints('git version 2.37.1')
  io.current = runOf(bindWorker(startBoard({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers: [{ id: 'w1', path: '/tmp/meld/r1/w1', ref: 'meld/r1/w1', agent: WORKER }] }), 'w1', 'agent-1', NOW))
  const result = await startRun(io, '/repo', { request: 'More', agents: TWO, vcs: 'git' })
  expect(result.text).toBe('A run is active. Deliver, discard or stop it first: /meld-deliver, /meld-discard or /meld-stop, or the meld pane.')
  expect(io.ran('git version')).toBe(false)
})
