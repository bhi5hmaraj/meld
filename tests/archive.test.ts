import { expect, test } from 'claude-code/testing'

import { deliver, discard } from '../core/actions'
import { addTasks, bindWorker, declareFinal, isFailure, shareEntry, startRun, steer, takeIntegration } from '../core/board'
import type { AgentSpec, Change, Run, WorkerId } from '../types'
import { ARCHIVE, FakeIo, HEAD } from './fake-io'

const NOW = 1_800_000_000_000
const FULL = 'f'.repeat(40)
const REQUEST = 'Add a dark theme'
const STEER = 'Keep the old colors as an option'
const TASK = 'Theme switch'
const FACT = 'The colors live in theme.ts'
const FILE = `${ARCHIVE}/r1.json`
const MAKE_FOLDER = `mkdir -p -m 700 ${ARCHIVE}`
const OWNER_ONLY = `chmod 600 ${FILE}`
const FOLDER_OWNER_ONLY = `chmod 700 ${ARCHIVE}`
const REMOVE_HOME = 'rm -rf -- /tmp/meld/r1'
const KEPT = 'The run and its workspaces stay.'
const WORKER: AgentSpec = { type: 'meld:worker' }
const IDS: WorkerId[] = ['w1', 'w2']

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

/** A working run with a steer, one task and one context entry. */
function working(): Run {
  const workers = IDS.map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: `meld/r1/${id}`, agent: WORKER }))
  let run = startRun({ id: 'r1', request: REQUEST, repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers })
  for (const [index, id] of IDS.entries()) run = runOf(bindWorker(run, id, `agent-${index + 1}`, NOW))
  run = runOf(steer(run, STEER, NOW))
  run = runOf(addTasks(run, 'w1', { seen: run.taskList, tasks: [{ title: TASK }] }, NOW))
  return runOf(shareEntry(run, 'w1', { kind: 'fact', text: FACT }, NOW))
}

function ready(): Run {
  return runOf(declareFinal(runOf(takeIntegration(working(), 'w2', NOW)), 'w2', FULL, 'A dark theme', NOW))
}

function ioWith(run: Run): FakeIo {
  const io = new FakeIo()
  io.current = run
  return io
}

test('Deliver writes the archive of the delivered run, open to its user only, before it removes the folder', async () => {
  const io = ioWith(ready())
  expect(await deliver(io)).toBe(`Merged ${FULL.slice(0, 7)} into your branch.`)
  const record = JSON.parse(io.files[FILE] ?? '{}')
  expect(record.run.id).toBe('r1')
  expect(record.run.state).toBe('delivered')
  expect(record.board.request).toBe(REQUEST)
  expect(record.board.steers).toEqual([STEER])
  expect(record.board.tasks.map((task: { title: string }) => task.title)).toEqual([TASK])
  expect(record.events.at(-1).text).toBe('delivered the final commit')
  expect(record.context.map((entry: { text: string }) => entry.text)).toEqual([FACT])
  expect(io.commands.indexOf(MAKE_FOLDER)).toBeGreaterThan(-1)
  expect(io.commands.indexOf(OWNER_ONLY)).toBeGreaterThan(-1)
  expect(io.commands.indexOf(OWNER_ONLY)).toBeLessThan(io.commands.indexOf(REMOVE_HOME))
})

test('Discard writes the archive before it removes the folder', async () => {
  const io = ioWith(working())
  expect(await discard(io)).toBe('The run and its workspaces are gone.')
  const record = JSON.parse(io.files[FILE] ?? '{}')
  expect(record.run.state).toBe('stopped')
  expect(record.board.steers).toEqual([STEER])
  expect(record.context.map((entry: { text: string }) => entry.text)).toEqual([FACT])
  expect(io.commands.indexOf(OWNER_ONLY)).toBeGreaterThan(-1)
  expect(io.commands.indexOf(OWNER_ONLY)).toBeLessThan(io.commands.indexOf(REMOVE_HOME))
})

test('Deliver with changes in the checkout refuses as before and writes no archive', async () => {
  const io = ioWith(ready())
  io.dirty = true
  expect(await deliver(io)).toBe('Commit or stash the changes in your checkout first, then deliver.')
  expect(io.files[FILE]).toBeUndefined()
})

test('Discard keeps the run and its folder when meld cannot write the archive', async () => {
  const io = ioWith(working())
  io.failing = [OWNER_ONLY]
  expect(await discard(io)).toBe(`meld could not write the archive ${FILE}: chmod: failed. ${KEPT}`)
  expect(io.current?.id).toBe('r1')
  expect(io.ran(REMOVE_HOME)).toBe(false)
})

test('Deliver merges nothing when meld cannot write the archive', async () => {
  const io = ioWith(ready())
  io.failing = [MAKE_FOLDER]
  expect(await deliver(io)).toBe(`meld could not write the archive ${FILE}: mkdir: failed. ${KEPT}`)
  expect(io.current?.state).toBe('ready')
  expect(io.ran('git merge')).toBe(false)
})

test('an archive folder that exists with a looser mode is open to its user only before meld writes the record', async () => {
  const io = ioWith(ready())
  await deliver(io)
  expect(io.commands.indexOf(FOLDER_OWNER_ONLY)).toBeGreaterThan(io.commands.indexOf(MAKE_FOLDER))
  expect(io.commands.indexOf(FOLDER_OWNER_ONLY)).toBeLessThan(io.commands.indexOf(OWNER_ONLY))
})
