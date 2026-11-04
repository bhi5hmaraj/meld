import { expect, test } from 'claude-code/testing'
import type { ToolCallInput } from 'claude-code'

import { markWorker, restartIdleWorkers, serveTool } from '../hooks/actions'
import { addIntegrateTask, addTasks, bindWorker, claimTask, finishTask, isFailure, lineMerged, startRun, unmergedTasks } from '../hooks/board'
import { workerRules } from '../hooks/contract'
import { JJ_RESOLVE_TEMPLATE } from '../hooks/vcs'
import type { Change, Run, VcsKind, WorkerId } from '../types'
import { FakeIo, HEAD } from './fake-io'
import { STORED_BY_0_6_0 } from './stored-runs'

const NOW = 1_800_000_000_000
const FULL = 'f'.repeat(40)
const OTHER = 'e'.repeat(40)
const LINE = 'c'.repeat(40)
const TREE = 'd'.repeat(40)
const GIT_LINE = 'refs/heads/meld/r1/integration'

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

function working(vcs: VcsKind = 'git'): Run {
  const ids: WorkerId[] = ['w1', 'w2', 'w3']
  const workers = ids.map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: vcs === 'jj' ? `${id}@` : `meld/r1/${id}`, agent: { type: 'meld:worker' } }))
  let run = startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs, now: NOW, workers })
  for (const [index, id] of ids.entries()) run = runOf(bindWorker(run, id, `agent-${index + 1}`, NOW))
  return run
}

/** Two tasks; w1 claims #1, and #2 is open. */
function planned(vcs: VcsKind = 'git'): Run {
  const added = runOf(addTasks(working(vcs), 'w1', { seen: 0, tasks: [{ title: 'Theme tokens' }, { title: 'Dark toggle' }] }, NOW))
  return runOf(claimTask(added, 'w1', 1, 1, NOW))
}

/** The task done by `by` at `at`, claimed first when it is open. */
function finished(run: Run, id: number, by: WorkerId, commit: string, at = NOW - 1000): Run {
  const task = run.tasks.find(one => one.id === id)
  const claimed = task?.state === 'open' ? runOf(claimTask(run, by, id, task.version, at)) : run
  const version = claimed.tasks.find(one => one.id === id)?.version ?? 0
  return runOf(finishTask(claimed, by, id, version, commit, `did #${id}`, at))
}

function call(input: Record<string, unknown>): ToolCallInput {
  return input as unknown as ToolCallInput
}

function parsed(result: unknown): unknown {
  if (typeof result !== 'string') throw new Error(`a tool result is a string, not ${typeof result}`)
  return JSON.parse(result)
}

function ioWith(run: Run): FakeIo {
  const io = new FakeIo()
  io.current = run
  io.answers['git rev-parse --verify --quiet HEAD^{commit}'] = FULL
  return io
}

const FINISH_1 = { tool: 'mcp__meld__finish_task', task: 1, version: 2, commit: 'HEAD', summary: 'Tokens', agentId: 'agent-1' }

test('a merge into the line moves its head and records the task that it holds', () => {
  const run = lineMerged(lineMerged(working(), 1, OTHER, NOW), 2, LINE, NOW)
  expect(run.line).toEqual({ head: LINE, tasks: [1, 2] })
})

test('meld adds a task "integrate #N" of size S when the commit of #N does not merge into the line', () => {
  const run = finished(runOf(addTasks(working(), 'w1', { seen: 0, tasks: [{ title: 'Theme tokens' }] }, NOW)), 1, 'w1', FULL)
  const change = addIntegrateTask(run, 1, 'conflicts in src/theme.ts', NOW)
  if (isFailure(change)) throw new Error(change.message)
  expect(change.value).toMatchObject({ id: 2, title: 'integrate #1', size: 'S', state: 'open', integrates: 1, detail: 'conflicts in src/theme.ts' })
  expect(change.run.taskList).toBe(run.taskList + 1)
  expect(change.run.log.at(-1)).toMatchObject({ by: 'you', kind: 'task', text: 'added #2 integrate #1' })
})

test('the line holds an integrated task once the commit of its integrate task merges', () => {
  const run = runOf(addIntegrateTask(finished(runOf(addTasks(working(), 'w1', { seen: 0, tasks: [{ title: 'Theme tokens' }] }, NOW)), 1, 'w1', FULL), 1, '', NOW))
  expect(lineMerged(run, 2, LINE, NOW).line).toEqual({ head: LINE, tasks: [2, 1] })
})

test('the tasks to merge are the done leaves with a commit that the line does not hold, in the order they were done', () => {
  const three = runOf(addTasks(working(), 'w1', { seen: 0, tasks: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] }, NOW))
  const two = finished(finished(three, 2, 'w2', OTHER, NOW - 2000), 1, 'w1', FULL, NOW - 1000)
  expect(unmergedTasks(two).map(task => task.id)).toEqual([2, 1])
  expect(unmergedTasks(lineMerged(two, 2, OTHER, NOW)).map(task => task.id)).toEqual([1])
  expect(unmergedTasks(runOf(addIntegrateTask(two, 1, '', NOW))).map(task => task.id)).toEqual([2])
})

test('a run that meld 0.6.0 stored has no line, and its done task is still to merge', () => {
  expect(STORED_BY_0_6_0.line).toBeUndefined()
  expect(unmergedTasks(STORED_BY_0_6_0).map(task => task.id)).toEqual([1])
})

test('finish_task merges the commit of the task into the integration line, with no agent', async () => {
  const io = ioWith(planned())
  io.failing = [`git rev-parse --verify --quiet ${GIT_LINE}`, `git merge-base --is-ancestor ${FULL} ${HEAD}`]
  const replied = await serveTool(io, call(FINISH_1))
  expect(parsed(replied.result)).toMatchObject({ ok: true })
  expect(io.commands).toContain(`git update-ref ${GIT_LINE} ${FULL} `)
  expect(io.current?.line).toEqual({ head: FULL, tasks: [1] })
  expect(io.spawned).toHaveLength(0)
})

test('a merge that conflicts leaves the line and adds "integrate #N" for a worker, with the files and the steps', async () => {
  const io = ioWith(planned())
  io.answers[`git rev-parse --verify --quiet ${GIT_LINE}^{commit}`] = LINE
  io.failing = [`git merge-base --is-ancestor ${FULL} ${LINE}`, `git merge-base --is-ancestor ${LINE} ${FULL}`]
  io.outcomes[`git merge-tree --write-tree --name-only --no-messages ${LINE} ${FULL}`] = { exitCode: 1, stdout: `${TREE}\nsrc/theme.ts\n`, stderr: '' }
  await serveTool(io, call(FINISH_1))
  const integrate = io.current?.tasks.find(task => task.title === 'integrate #1')
  expect(integrate).toMatchObject({ size: 'S', state: 'open', integrates: 1 })
  expect(integrate?.detail).toContain('src/theme.ts')
  expect(integrate?.detail).toContain('git merge meld/r1/integration')
  expect(integrate?.detail).toContain(`git merge ${FULL}`)
  expect(io.current?.line).toBeUndefined()
  expect(io.sent.some(message => message.startsWith('agent-2: meld: There is open work on the board.'))).toBe(true)
})

test('on jj the task "integrate #N" names the bookmark of the line and the commit to merge', async () => {
  const io = ioWith(planned('jj'))
  io.answers[`jj -R /tmp/meld/r1/w1 --ignore-working-copy log --no-graph -r HEAD -T ${JJ_RESOLVE_TEMPLATE}`] = `${FULL} clean`
  io.answers[`jj -R /tmp/meld/r1/jj --ignore-working-copy log --no-graph -r ${FULL} -T ${JJ_RESOLVE_TEMPLATE}`] = `${FULL} conflict`
  await serveTool(io, call(FINISH_1))
  const integrate = io.current?.tasks.find(task => task.title === 'integrate #1')
  expect(integrate?.detail).toContain(`jj new meld_integration ${FULL}`)
})

test('a finish merges the done tasks that the line does not hold yet, in the order they were done', async () => {
  const io = ioWith(finished(planned(), 2, 'w2', OTHER))
  io.failing = [`git rev-parse --verify --quiet ${GIT_LINE}`]
  await serveTool(io, call(FINISH_1))
  const merged = io.commands.filter(command => command.startsWith('git merge-tree') || command.startsWith('git update-ref'))
  expect(merged[0]).toContain(OTHER)
  expect(io.current?.line?.tasks).toEqual([2, 1])
})

test('when every task is done and the line holds them, the integrator starts from the line and runs one final build', async () => {
  const done = finished(finished(planned(), 2, 'w2', OTHER), 1, 'w1', FULL)
  const io = ioWith({ ...lineMerged(lineMerged(done, 2, OTHER, NOW), 1, LINE, NOW), integrator: 'w2' })
  for (const agent of ['agent-1', 'agent-2', 'agent-3']) await markWorker(io, agent, 'idle')
  await restartIdleWorkers(io)
  expect(io.spawned).toHaveLength(1)
  const prompt = io.spawned[0]?.prompt ?? ''
  expect(prompt).toContain('meld/r1/integration')
  expect(prompt).toContain(LINE.slice(0, 12))
  expect(prompt).toContain('one final build')
})

test('when the line lacks a done task, the integrator merges its commit too', async () => {
  const done = finished(finished(planned(), 2, 'w2', OTHER), 1, 'w1', FULL)
  const io = ioWith({ ...lineMerged(done, 2, LINE, NOW), integrator: 'w2' })
  for (const agent of ['agent-1', 'agent-2', 'agent-3']) await markWorker(io, agent, 'idle')
  await restartIdleWorkers(io)
  expect(io.spawned[0]?.prompt).toContain(`#1 (${FULL.slice(0, 12)})`)
})

test('the rules name the integration line, and merge the branch of a peer only when the task needs that code', () => {
  const git = workerRules(working(), 'w1')
  expect(git).toContain('Merge the branch of a peer only when your own task needs that code')
  expect(git).toContain('meld/r1/integration')
  expect(git).toContain('integrate #N')
  const jj = workerRules(working('jj'), 'w1')
  expect(jj).toContain('meld_integration')
  expect(jj).not.toContain('jj new @- w2@- w3@-')
})
