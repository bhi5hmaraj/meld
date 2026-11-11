import { expect, test } from 'claude-code/testing'
import type { ToolCallInput } from 'claude-code'

import { serveTool } from '../core/actions'
import { addNote, addTasks, bindWorker, claimTask, finishTask, isFailure, passContext, setWorkerState, shareEntry, startRun } from '../core/board'
import { TOOL } from '../core/contract'
import type { Change, Run, WorkerId } from '../types'
import { FakeIo, HEAD } from './fake-io'

const NOW = 1_800_000_000_000
const FULL = 'f'.repeat(40)

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

/** A run with a task in each state, needs on done and undone tasks, and a worker that is idle since 90 s. */
function planned(): Run {
  const workers = (['w1', 'w2'] as WorkerId[]).map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: `meld/r1/${id}`, agent: { type: 'meld:worker' } }))
  let run = startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers })
  run = runOf(bindWorker(run, 'w1', 'agent-1', NOW))
  run = runOf(bindWorker(run, 'w2', 'agent-2', NOW))
  const tasks = [{ title: 'Theme tokens' }, { title: 'Dark pane', needs: [1] }, { title: 'Docs' }, { title: 'Theme guide', needs: [1, 3] }]
  run = runOf(addTasks(run, 'w1', { seen: run.taskList, tasks }, NOW))
  run = runOf(claimTask(run, 'w1', 1, 1, NOW))
  run = runOf(claimTask(run, 'w2', 3, 1, NOW))
  run = runOf(finishTask(run, 'w2', 3, 2, FULL, 'Docs written', NOW))
  return setWorkerState(run, 'w2', 'idle', NOW - 90_000)
}

async function status(io: FakeIo): Promise<Record<string, unknown>> {
  const replied = await serveTool(io, { tool: TOOL.board, view: 'status' } as unknown as ToolCallInput)
  return JSON.parse(replied.result) as Record<string, unknown>
}

test('the status view gives the task counts, a row for each task and a row for each worker', async () => {
  const io = new FakeIo()
  io.current = planned()
  const { log: _log, ...rows } = await status(io)
  expect(rows).toEqual({
    id: 'r1',
    state: 'working',
    counts: { open: 2, claimed: 1, done: 1 },
    tasks: [
      { id: 1, title: 'Theme tokens', state: 'claimed', owner: 'w1', needs: [] },
      { id: 2, title: 'Dark pane', state: 'open', needs: [1] },
      { id: 3, title: 'Docs', state: 'done', owner: 'w2', needs: [] },
      { id: 4, title: 'Theme guide', state: 'open', needs: [1] },
    ],
    workers: [
      { id: 'w1', state: 'working', claims: [1], secondsSinceCall: 0 },
      { id: 'w2', state: 'idle', claims: [], secondsSinceCall: 90 },
    ],
  })
})

test('a status read gives the log entries since the last status read of the main session', async () => {
  const io = new FakeIo()
  io.current = planned()
  const first = (await status(io)).log as { text: string }[]
  expect(first.map(entry => entry.text)).toEqual(io.current.log.map(entry => entry.text))
  io.current = runOf(addNote(io.current as Run, 'w1', 'The tokens are in theme.ts', undefined, NOW))
  expect(((await status(io)).log as { text: string }[]).map(entry => entry.text)).toEqual(['The tokens are in theme.ts'])
  expect((await status(io)).log).toEqual([])
})

test('the status view and the full board of the main session leave out the delivered entries', async () => {
  const io = new FakeIo()
  io.current = passContext(runOf(shareEntry(planned(), 'w1', { kind: 'fact', text: 'The tokens are in theme.ts' }, NOW)), 'w2', NOW).run
  expect(io.current.log.some(entry => entry.kind === 'delivered')).toBe(true)
  const full = JSON.parse((await serveTool(io, { tool: TOOL.board } as unknown as ToolCallInput)).result) as { log: { kind: string }[] }
  const statusLog = (await status(io)).log as { kind: string }[]
  expect(full.log.map(entry => entry.kind)).toContain('share')
  expect([...full.log, ...statusLog].filter(entry => entry.kind === 'delivered')).toEqual([])
  expect(statusLog.map(entry => entry.kind)).toContain('share')
})

test('the status view and the full board of the main session keep a start or a stop of a worker, and leave out its other changes of state', async () => {
  const io = new FakeIo()
  const run = planned()
  const last = run.log.at(-1)?.id ?? 0
  const lane: Run['log'] = [
    { id: last + 1, at: NOW, by: 'you', kind: 'worker', worker: 'w1', state: 'idle', text: 'w1 is idle' },
    { id: last + 2, at: NOW, by: 'you', kind: 'worker', worker: 'w1', state: 'working', start: 'restart', text: 'w1 starts again' },
    { id: last + 3, at: NOW, by: 'you', kind: 'worker', worker: 'w2', state: 'stopped', text: 'stopped w2' },
  ]
  io.current = { ...run, log: [...run.log, ...lane] }
  const full = JSON.parse((await serveTool(io, { tool: TOOL.board } as unknown as ToolCallInput)).result) as { log: Run['log'] }
  const statusLog = (await status(io)).log as Run['log']
  expect(full.log.filter(entry => entry.kind === 'worker').map(entry => entry.text)).toEqual(['w1 starts again', 'stopped w2'])
  expect(statusLog.filter(entry => entry.kind === 'worker').map(entry => entry.text)).toEqual(['w1 starts again', 'stopped w2'])
})

test('a board read with no view gives the main session the full board', async () => {
  const io = new FakeIo()
  io.current = planned()
  const replied = JSON.parse((await serveTool(io, { tool: TOOL.board } as unknown as ToolCallInput)).result) as Record<string, unknown>
  expect(replied.request).toBe('Add a dark theme')
  expect(replied.counts).toBeUndefined()
})
