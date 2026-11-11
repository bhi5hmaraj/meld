import { expect, test } from 'claude-code/testing'
import type { ToolCallInput } from 'claude-code'

import { serveTool } from '../core/actions'
import { addNote, addTasks, bindWorker, claimTask, isFailure, splitTask, startRun, steer } from '../core/board'
import { TOOL } from '../core/contract'
import { INLINE_CHARS, nodeText, viewFiles, viewRoot } from '../core/view'
import type { Change, Run, WorkerId } from '../types'
import { FakeIo, HEAD } from './fake-io'

const NOW = 1_800_000_000_000
const REQUEST = 'Add a dark theme'
const STEER = 'Keep the light theme as the default'
const DETAIL = 'Put the colours in src/theme.css as CSS variables.'
const LONG_NOTE = `The tokens moved. ${'x'.repeat(INLINE_CHARS)}`
const ROOT = '/tmp/meld/r1/board'

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

/** Two workers, two tasks with a detail, w1 on #1, one steer, and a long note of w1. */
function planned(): Run {
  const workers = (['w1', 'w2'] as WorkerId[]).map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: `meld/r1/${id}`, agent: { type: 'meld:worker' } }))
  let run = startRun({ id: 'r1', request: REQUEST, repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers })
  run = runOf(bindWorker(run, 'w1', 'agent-1', NOW))
  run = runOf(bindWorker(run, 'w2', 'agent-2', NOW))
  const tasks = [{ title: 'Theme tokens', detail: DETAIL }, { title: 'Dark pane', detail: DETAIL, needs: [1] }]
  run = runOf(addTasks(run, 'w1', { seen: run.taskList, tasks }, NOW))
  run = runOf(claimTask(run, 'w1', 1, 1, NOW))
  run = runOf(steer(run, STEER, NOW))
  return runOf(addNote(run, 'w1', LONG_NOTE, undefined, NOW))
}

function ioWith(run: Run, store: 'file' | 'session' = 'file'): FakeIo {
  const io = new FakeIo()
  io.current = run
  io.store = store
  return io
}

async function board(io: FakeIo, agentId: string, input: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const replied = await serveTool(io, { tool: TOOL.board, agentId, ...input } as unknown as ToolCallInput)
  return JSON.parse(replied.result) as Record<string, any>
}

test('the first board read of a worker carries the request, the steers and its rules', async () => {
  const first = await board(ioWith(planned()), 'agent-2')
  expect(first.request).toBe(REQUEST)
  expect(first.steers).toEqual([STEER])
  expect(first.rules).toContain('You are w2')
})

test('a later board read leaves the request and the steers out: the worker has them, and the ref gives them again', async () => {
  const io = ioWith(planned())
  await board(io, 'agent-2')
  const later = await board(io, 'agent-2')
  expect(later.request).toBeUndefined()
  expect(later.steers).toBeUndefined()
  expect(later.revision).toBe(2)
})

test('a board read gives one line for each task with its ref, and the claimed tasks of the reader in full', async () => {
  const view = await board(ioWith(planned()), 'agent-1')
  expect(view.tasks).toEqual([
    { id: 1, title: 'Theme tokens', state: 'claimed', version: 2, owner: 'w1', ref: 'tasks/1' },
    { id: 2, title: 'Dark pane', state: 'open', version: 1, needs: [1], ref: 'tasks/2' },
  ])
  expect(view.yours.map((task: { id: number; detail: string }) => [task.id, task.detail])).toEqual([[1, DETAIL]])
})

test('a long note comes as its first words with its size and its ref, and the ref gives it whole', async () => {
  const io = ioWith(planned())
  const view = await board(io, 'agent-2')
  const note = view.news.find((entry: { kind: string }) => entry.kind === 'note')
  expect(note.text.length).toBeLessThan(INLINE_CHARS)
  expect(note.chars).toBe(LONG_NOTE.length)
  const whole = await board(io, 'agent-2', { ref: note.ref })
  expect(whole.text).toContain(LONG_NOTE)
})

test('a board read names the folder of the board files when meld mcp keeps the run, and names none in the session state', async () => {
  expect((await board(ioWith(planned(), 'file'), 'agent-2')).more).toContain(ROOT)
  expect((await board(ioWith(planned(), 'session'), 'agent-2')).more).not.toContain(ROOT)
})

test('a ref gives one task with its detail, and a ref that names nothing is refused', async () => {
  const io = ioWith(planned())
  expect((await board(io, 'agent-2', { ref: 'tasks/2' })).text).toContain(DETAIL)
  expect((await board(io, 'agent-2', { ref: 'tasks/9' })).error).toBe('INVALID')
})

test('a stale add of tasks shows the current tasks as lines, not in full', async () => {
  const io = ioWith(planned())
  const replied = await serveTool(io, { tool: TOOL.addTasks, agentId: 'agent-2', seen: 0, tasks: [{ title: 'Docs' }] } as unknown as ToolCallInput)
  const refusal = JSON.parse(replied.result) as { error: string; tasks: Record<string, unknown>[] }
  expect(refusal.error).toBe('STALE_TASK_LIST')
  expect(refusal.tasks[0]).toEqual({ id: 1, title: 'Theme tokens', state: 'claimed', version: 2, owner: 'w1', ref: 'tasks/1' })
})

test('the board files hold the same texts that the refs give', () => {
  const run = planned()
  const files = viewFiles(run)
  expect(Object.keys(files).sort()).toEqual(['README.md', 'context.jsonl', 'log.jsonl', 'request.md', 'tasks.md', 'tasks/1.md', 'tasks/2.md'])
  expect(files['tasks/2.md']).toBe(nodeText(run, 'tasks/2'))
  expect(files['request.md']).toBe(nodeText(run, 'request'))
  expect(files['request.md']).toContain(STEER)
  expect(files['log.jsonl']).toContain(LONG_NOTE)
})

test('tasks.md shows the task tree: each part comes under its parent with two more spaces, and a top task starts at the left', () => {
  let run = planned()
  run = runOf(splitTask(run, 'w1', { task: 1, version: 2, seen: run.taskList, tasks: [{ title: 'Light tokens' }, { title: 'Dark tokens' }] }, NOW))
  run = runOf(splitTask(run, 'w1', { task: 3, version: 1, seen: run.taskList, tasks: [{ title: 'Light colours' }, { title: 'Light fonts' }] }, NOW))
  expect(viewFiles(run)['tasks.md']).toBe(
    [
      '#1 open: Theme tokens',
      '  #3 open: Light tokens',
      '    #5 claimed w1: Light colours',
      '    #6 open: Light fonts',
      '  #4 open: Dark tokens',
      '#2 open needs #1: Dark pane',
      '',
    ].join('\n'),
  )
})

test('the board files are in the folder of the run only for a run in the board file', () => {
  expect(viewRoot({ store: 'file' }, planned())).toBe(ROOT)
  expect(viewRoot({ store: 'session' }, planned())).toBeUndefined()
})
