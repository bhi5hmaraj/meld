import { expect, test } from 'claude-code/testing'
import type { ToolCallInput } from 'claude-code'

import { markWorker, restartIdleWorkers, serveTool } from '../core/actions'
import { addTasks, bindWorker, boardFor, claimTask, finishTask, handoversFor, isFailure, startRun, steer } from '../core/board'
import { HAND_BACK, TOOL, workerRules } from '../core/contract'
import { JJ_RESOLVE_TEMPLATE } from '../core/vcs'
import type { Change, NewTask, Run, WorkerId } from '../types'
import { FakeIo, HEAD } from './fake-io'
import { STORED_BY_0_7_0 } from './stored-runs'

const NOW = 1_800_000_000_000
const FULL = 'f'.repeat(40)
const OTHER = 'e'.repeat(40)
const RESOLVE_HEAD = 'git rev-parse --verify --quiet HEAD^{commit}'
const HANDOVER = { interfaces: '--bg and --fg in theme.css', unfinished: 'The print styles' }

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

function working(count = 3): Run {
  const ids = (['w1', 'w2', 'w3'] as WorkerId[]).slice(0, count)
  const workers = ids.map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: `meld/r1/${id}`, agent: { type: 'meld:worker' } }))
  let run = startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers })
  for (const [index, id] of ids.entries()) run = runOf(bindWorker(run, id, `agent-${index + 1}`, NOW))
  return run
}

function withTasks(tasks: NewTask[], run = working()): Run {
  return runOf(addTasks(run, 'w1', { seen: run.taskList, tasks }, NOW))
}

/** #1 Tokens is done by w1 with a handover, #2 Toggle needs it, and #3 Docs needs nothing. */
function tokensDone(): Run {
  const planned = withTasks([{ title: 'Tokens' }, { title: 'Toggle', needs: [1] }, { title: 'Docs' }])
  return runOf(finishTask(runOf(claimTask(planned, 'w1', 1, 1, NOW)), 'w1', 1, 2, 'def5678', 'Tokens added', NOW, HANDOVER))
}

function ioWith(run: Run): FakeIo {
  const io = new FakeIo()
  io.current = run
  io.answers[RESOLVE_HEAD] = FULL
  return io
}

function call(input: Record<string, unknown>): ToolCallInput {
  return input as unknown as ToolCallInput
}

async function serve(io: FakeIo, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = (await serveTool(io, call(input))).result
  if (typeof result !== 'string') throw new Error(`a tool result is a string, not ${typeof result}`)
  return JSON.parse(result) as Record<string, unknown>
}

test('the rules tell a worker to hand back after finish_task, and to claim no next task', () => {
  expect(workerRules(working(), 'w2')).toContain(
    `After ${TOOL.finishTask}, hand back: end your run. Do not claim the next task: meld starts a new agent for you when a task is ready.`,
  )
})

test('the rules tell a worker that a claim gives the handovers of the tasks it needs', () => {
  expect(workerRules(working(), 'w1')).toContain('The reply of a claim gives the handovers of the tasks that your task needs')
})

test('the reply of finish_task tells a worker with no other claim to hand back', async () => {
  const io = ioWith(runOf(claimTask(withTasks([{ title: 'Tokens' }, { title: 'Docs' }]), 'w1', 1, 1, NOW)))
  const replied = await serve(io, { tool: TOOL.finishTask, task: 1, version: 2, commit: 'HEAD', summary: 'Tokens added', agentId: 'agent-1' })
  expect(replied).toMatchObject({ ok: true, value: { id: 1, state: 'done' }, next: HAND_BACK })
})

test('the reply of finish_task does not send away a worker that still claims a task', async () => {
  const both = runOf(claimTask(runOf(claimTask(withTasks([{ title: 'Tokens' }, { title: 'Docs' }]), 'w1', 1, 1, NOW)), 'w1', 2, 1, NOW))
  const replied = await serve(ioWith(both), { tool: TOOL.finishTask, task: 1, version: 2, commit: 'HEAD', summary: 'Tokens added', agentId: 'agent-1' })
  expect(replied).toMatchObject({ ok: true })
  expect(replied.next).toBeUndefined()
})

test('a refused finish_task does not tell the worker to hand back', async () => {
  const io = ioWith(runOf(claimTask(withTasks([{ title: 'Tokens' }]), 'w1', 1, 1, NOW)))
  const replied = await serve(io, { tool: TOOL.finishTask, task: 1, version: 1, commit: 'HEAD', summary: 'Tokens added', agentId: 'agent-1' })
  expect(replied).toMatchObject({ error: 'STALE_VERSION' })
  expect(replied.next).toBeUndefined()
})

test('a worker that finished its task and handed back starts again while a task is ready, with no news', async () => {
  const io = ioWith(withTasks([{ title: 'Tokens' }, { title: 'Docs' }, { title: 'Toggle' }], working(2)))
  await serve(io, { tool: TOOL.claim, task: 1, version: 1, agentId: 'agent-1' })
  await serve(io, { tool: TOOL.board, agentId: 'agent-2' })
  await serve(io, { tool: TOOL.claim, task: 2, version: 1, agentId: 'agent-2' })
  await serve(io, { tool: TOOL.finishTask, task: 2, version: 2, commit: 'HEAD', summary: 'Docs written', agentId: 'agent-2' })
  await markWorker(io, 'agent-2', 'idle')
  await restartIdleWorkers(io)
  expect(io.spawned.map(spawn => [spawn.description, spawn.cwd])).toEqual([['meld w2', '/tmp/meld/r1/w2']])
  expect(io.spawned[0]?.prompt).toContain('These tasks are open: #3 Toggle. Claim one and do it.')
  expect(io.current?.workers[1]).toMatchObject({ agentId: 'spawned-1', state: 'working', briefed: false })
})

test('a worker that handed back stays idle while no task is ready', async () => {
  const io = ioWith(withTasks([{ title: 'Tokens' }, { title: 'Toggle', needs: [1] }], working(2)))
  await serve(io, { tool: TOOL.claim, task: 1, version: 1, agentId: 'agent-1' })
  await markWorker(io, 'agent-2', 'idle')
  await restartIdleWorkers(io)
  expect(io.spawned).toHaveLength(0)
  await serve(io, { tool: TOOL.finishTask, task: 1, version: 2, commit: 'HEAD', summary: 'Tokens added', agentId: 'agent-1' })
  await markWorker(io, 'agent-1', 'idle')
  await restartIdleWorkers(io)
  expect(io.spawned.map(spawn => spawn.description)).toEqual(['meld w1'])
  expect(io.spawned[0]?.prompt).toContain('These tasks are open: #2 Toggle.')
})

test('meld starts no more workers than there are tasks to claim', async () => {
  const io = ioWith(withTasks([{ title: 'Tokens' }, { title: 'Docs' }]))
  await serve(io, { tool: TOOL.claim, task: 1, version: 1, agentId: 'agent-1' })
  await serve(io, { tool: TOOL.board, agentId: 'agent-2' })
  await serve(io, { tool: TOOL.board, agentId: 'agent-3' })
  await markWorker(io, 'agent-2', 'idle')
  await markWorker(io, 'agent-3', 'idle')
  await restartIdleWorkers(io)
  expect(io.spawned.map(spawn => spawn.description)).toEqual(['meld w2'])
})

test('a finished task keeps its handover', () => {
  expect(tokensDone().tasks[0]?.handover).toEqual(HANDOVER)
})

test('a task finished with no interfaces and nothing unfinished keeps no handover', () => {
  const claimed = runOf(claimTask(withTasks([{ title: 'Tokens' }]), 'w1', 1, 1, NOW))
  expect(runOf(finishTask(claimed, 'w1', 1, 2, 'def5678', 'Tokens added', NOW, { interfaces: ' ' })).tasks[0]?.handover).toBeUndefined()
})

test('the handovers of a task come from the done tasks that it needs, with their commits', () => {
  const run = tokensDone()
  expect(handoversFor(run, 2)).toEqual([{ task: 1, title: 'Tokens', commit: 'def5678', ...HANDOVER }])
  expect(handoversFor(run, 3)).toEqual([])
})

test('a need with no handover still gives its commit', () => {
  const planned = withTasks([{ title: 'Tokens' }, { title: 'Toggle', needs: [1] }])
  const done = runOf(finishTask(runOf(claimTask(planned, 'w1', 1, 1, NOW)), 'w1', 1, 2, 'def5678', 'Tokens added', NOW))
  expect(handoversFor(done, 2)).toEqual([{ task: 1, title: 'Tokens', commit: 'def5678' }])
})

test('a part gets the handovers of what its parent needs, and a need with parts gives the handovers of its parts', () => {
  const planned = withTasks([
    { title: 'Theme' },
    { title: 'Toggle', needs: [1] },
    { title: 'Tokens', parent: 1 },
    { title: 'Print styles', parent: 1 },
    { title: 'Button', parent: 2 },
  ])
  const tokens = runOf(finishTask(runOf(claimTask(planned, 'w1', 3, 1, NOW)), 'w1', 3, 2, 'aaa1111', 'Tokens added', NOW, { interfaces: '--bg in theme.css' }))
  const print = runOf(finishTask(runOf(claimTask(tokens, 'w2', 4, 1, NOW)), 'w2', 4, 2, 'bbb2222', 'Print styles', NOW, { unfinished: 'Dark print' }))
  expect(print.tasks[0]?.state).toBe('done')
  expect(handoversFor(print, 5)).toEqual([
    { task: 3, title: 'Tokens', commit: 'aaa1111', interfaces: '--bg in theme.css' },
    { task: 4, title: 'Print styles', commit: 'bbb2222', unfinished: 'Dark print' },
  ])
})

test('a board read shows the handovers that the claims of its reader need, and the task list holds no handover', () => {
  const run = runOf(claimTask(tokensDone(), 'w2', 2, 1, NOW))
  const view = boardFor(run, 'w2').view
  expect(view.handovers).toEqual([{ task: 1, title: 'Tokens', commit: 'def5678', ...HANDOVER }])
  expect(view.tasks.map(task => 'handover' in task)).toEqual([false, false, false])
  expect(boardFor(run, 'w3').view.handovers).toBeUndefined()
})

test('a claim answers with the handovers of the tasks that the task needs', async () => {
  const io = ioWith(tokensDone())
  const replied = await serve(io, { tool: TOOL.claim, task: 2, version: 1, agentId: 'agent-2' })
  expect(replied).toMatchObject({ ok: true, value: { id: 2, state: 'claimed', owner: 'w2' }, handovers: [{ task: 1, title: 'Tokens', commit: 'def5678', ...HANDOVER }] })
})

test('a claim of a task that needs nothing answers with no handovers', async () => {
  const replied = await serve(ioWith(tokensDone()), { tool: TOOL.claim, task: 3, version: 1, agentId: 'agent-2' })
  expect(replied).toMatchObject({ ok: true })
  expect(replied.handovers).toBeUndefined()
})

test('a new agent for a ready task starts from the board, and its claim brings the handovers of what the task needs', async () => {
  const io = ioWith(runOf(steer(tokensDone(), 'Use the brand colours', NOW)))
  await serve(io, { tool: TOOL.board, agentId: 'agent-1' })
  await serve(io, { tool: TOOL.board, agentId: 'agent-3' })
  await serve(io, { tool: TOOL.claim, task: 3, version: 1, agentId: 'agent-3' })
  await markWorker(io, 'agent-1', 'idle')
  await markWorker(io, 'agent-2', 'idle')
  await restartIdleWorkers(io)
  expect(io.spawned.map(spawn => spawn.description)).toEqual(['meld w1'])
  const view = await serve(io, { tool: TOOL.board, agentId: 'spawned-1' })
  expect(view).toMatchObject({ request: 'Add a dark theme', steers: ['Use the brand colours'], tasks: [{ id: 1, state: 'done' }, { id: 2, state: 'open' }, { id: 3, state: 'claimed' }] })
  expect(view.rules).toContain('You are w1')
  const claimed = await serve(io, { tool: TOOL.claim, task: 2, version: 1, agentId: 'spawned-1' })
  expect(claimed).toMatchObject({ ok: true, handovers: [{ task: 1, commit: 'def5678', ...HANDOVER }] })
})

test('a task added to a run that meld 0.7.0 stored gets the commit of its done need as its handover', async () => {
  const toggle = STORED_BY_0_7_0.tasks[1]
  const planned = runOf(addTasks(STORED_BY_0_7_0, 'w3', { seen: 2, tasks: [{ title: 'Toggle docs', needs: [2] }] }, NOW))
  expect(handoversFor(planned, 6)).toEqual([{ task: 2, title: 'Dark toggle', commit: toggle?.commit }])
  const claimed = await serve(ioWith(planned), { tool: TOOL.claim, task: 6, version: 1, agentId: 'agent-3' })
  expect(claimed).toMatchObject({ ok: true, value: { id: 6, owner: 'w3' }, handovers: [{ task: 2, title: 'Dark toggle', commit: toggle?.commit }] })
})

test('a board read of a run that meld 0.7.0 stored shows its tasks as they were, and no handovers', () => {
  const view = boardFor(STORED_BY_0_7_0, 'w1').view
  expect(view.tasks).toEqual(STORED_BY_0_7_0.tasks)
  expect(view.handovers).toBeUndefined()
})

test('an idle worker of a run that meld 0.7.0 stored starts again when a task gets ready, and its claim brings the handovers', async () => {
  const colour = runOf(finishTask(STORED_BY_0_7_0, 'w1', 4, 1, FULL, 'Colour tokens', NOW, { interfaces: '--bg in tokens.css' }))
  const io = ioWith(runOf(finishTask(colour, 'w2', 5, 2, OTHER, 'Spacing tokens', NOW)))
  await markWorker(io, 'agent-1', 'idle')
  await markWorker(io, 'agent-2', 'idle')
  await restartIdleWorkers(io)
  expect(io.spawned.map(spawn => [spawn.description, spawn.cwd])).toEqual([['meld w1', '/tmp/meld/r070/w1']])
  expect(io.spawned[0]?.prompt).toContain('These tasks are open: #3 Docs for the theme.')
  const claimed = await serve(io, { tool: TOOL.claim, task: 3, version: 1, agentId: 'spawned-1' })
  expect(claimed).toMatchObject({
    ok: true,
    handovers: [
      { task: 4, title: 'Colour tokens', commit: FULL, interfaces: '--bg in tokens.css' },
      { task: 5, title: 'Spacing tokens', commit: OTHER },
    ],
  })
})

test('a finish_task on a run that meld 0.7.0 stored tells its worker to hand back', async () => {
  const io = ioWith(STORED_BY_0_7_0)
  io.answers[`jj -R /tmp/meld/r070/w1 --ignore-working-copy log --no-graph -r @- -T ${JJ_RESOLVE_TEMPLATE}`] = `${FULL} clean`
  const replied = await serve(io, { tool: TOOL.finishTask, task: 4, version: 1, commit: '@-', summary: 'Colour tokens', agentId: 'agent-1' })
  expect(replied).toMatchObject({ ok: true, value: { id: 4, state: 'done', commit: FULL }, next: HAND_BACK })
})
