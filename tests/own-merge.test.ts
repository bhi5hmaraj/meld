import { expect, test } from 'claude-code/testing'
import type { ToolCallInput } from 'claude-code'

import { markWorker, restartIdleWorkers, serveTool } from '../core/actions'
import { addTasks, bindWorker, claimTask, finishTask, isFailure, lackingTasks, startRun } from '../core/board'
import type { Change, Run, WorkerId } from '../types'
import { FakeIo, HEAD } from './fake-io'

const NOW = 1_800_000_000_000
const FULL = 'f'.repeat(40)
const TOGGLE = 'b'.repeat(40)
const DOCS = 'd'.repeat(40)
const ICONS = 'e'.repeat(40)
const GIT_LINE = 'refs/heads/meld/r1/integration'
const IDS: WorkerId[] = ['w1', 'w2', 'w3']
const FINISH_1 = { tool: 'mcp__meld__finish_task', task: 1, version: 2, commit: 'HEAD', summary: 'Tokens', agentId: 'agent-1' }
const FINISH_2 = { tool: 'mcp__meld__finish_task', task: 2, version: 2, commit: TOGGLE, summary: 'Toggle', agentId: 'agent-2' }
const MERGE_1 = [`git merge-base --is-ancestor ${FULL} ${HEAD}`, `git merge-base --is-ancestor ${HEAD} ${FULL}`, `git update-ref ${GIT_LINE} ${FULL} `]
const MERGE_2 = [`git merge-base --is-ancestor ${TOGGLE} ${HEAD}`, `git merge-base --is-ancestor ${HEAD} ${TOGGLE}`, `git update-ref ${GIT_LINE} ${TOGGLE} `]

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

/** Four tasks on git, and w1 claims #1 Theme tokens. */
function planned(): Run {
  const workers = IDS.map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: `meld/r1/${id}`, agent: { type: 'meld:worker' } }))
  let run = startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers })
  for (const [index, id] of IDS.entries()) run = runOf(bindWorker(run, id, `agent-${index + 1}`, NOW))
  const tasks = [{ title: 'Theme tokens' }, { title: 'Dark toggle' }, { title: 'Docs' }, { title: 'Icons' }]
  return runOf(claimTask(runOf(addTasks(run, 'w1', { seen: 0, tasks }, NOW)), 'w1', 1, 1, NOW))
}

/** The task claimed and finished by `by` with `commit`, with no merge into the line. */
function finished(run: Run, id: number, by: WorkerId, commit: string): Run {
  const claimed = runOf(claimTask(run, by, id, run.tasks.find(task => task.id === id)?.version ?? 0, NOW))
  return runOf(finishTask(claimed, by, id, claimed.tasks.find(task => task.id === id)?.version ?? 0, commit, `did #${id}`, NOW))
}

/** A backlog: #2, #3 and #4 are done, and the line holds none of them, as after a restart of the session or in a run of meld 0.7.0. */
function backlog(): Run {
  return finished(finished(finished(planned(), 2, 'w2', TOGGLE), 3, 'w3', DOCS), 4, 'w2', ICONS)
}

/** The line has no branch yet, so it starts at the base, and each commit of a finished task moves it forward. */
function ioWith(run: Run): FakeIo {
  const io = new FakeIo()
  io.current = run
  io.answers['git rev-parse --verify --quiet HEAD^{commit}'] = FULL
  io.answers[`git rev-parse --verify --quiet ${TOGGLE}^{commit}`] = TOGGLE
  io.failing = [`git rev-parse --verify --quiet ${GIT_LINE}`, `git merge-base --is-ancestor ${FULL} ${HEAD}`, `git merge-base --is-ancestor ${TOGGLE} ${HEAD}`]
  return io
}

function call(input: Record<string, unknown>): ToolCallInput {
  return input as unknown as ToolCallInput
}

/** The git commands of the merges into the line, in the order they ran. */
function merges(io: FakeIo): string[] {
  return io.commands.filter(command => /^git (merge-base|merge-tree|commit-tree|update-ref) /.test(command))
}

test('a finish_task merges the commit of its own task alone, so a backlog of done tasks that the line lacks adds no merge to its wait', async () => {
  const io = ioWith(backlog())
  const replied = await serveTool(io, call(FINISH_1))
  expect(JSON.parse(String(replied.result))).toMatchObject({ ok: true, value: { id: 1, state: 'done', commit: FULL } })
  expect(merges(io)).toEqual(MERGE_1)
  expect(io.current?.line).toEqual({ head: FULL, tasks: [1] })
})

test('the done tasks that the line lacks wait for the integrator, who starts from the line and merges their commits', async () => {
  const io = ioWith(backlog())
  await serveTool(io, call(FINISH_1))
  expect(io.current && lackingTasks(io.current).map(task => task.id)).toEqual([2, 3, 4])
  for (const agent of ['agent-1', 'agent-2', 'agent-3']) await markWorker(io, agent, 'idle')
  await restartIdleWorkers(io)
  expect(io.spawned).toHaveLength(1)
  expect(io.spawned[0]?.prompt).toContain(`The line lacks #2 (${TOGGLE.slice(0, 12)}), #3 (${DOCS.slice(0, 12)}), #4 (${ICONS.slice(0, 12)}): merge those commits too.`)
})

test('a finish_task that meld refuses merges nothing, though done tasks wait for the line', async () => {
  const io = ioWith(backlog())
  const replied = await serveTool(io, call({ ...FINISH_1, version: 1 }))
  expect(JSON.parse(String(replied.result))).toMatchObject({ error: 'STALE_VERSION' })
  expect(merges(io)).toEqual([])
  expect(io.current?.line).toBeUndefined()
})

test('a finish_task keeps the commits that its commit took from other lanes', async () => {
  const io = ioWith(backlog())
  io.answers[`git rev-list --count --no-merges ${HEAD}..${FULL}`] = '5'
  io.answers[`git rev-list --count --no-merges --first-parent ${HEAD}..${FULL}`] = '3'
  await serveTool(io, call(FINISH_1))
  expect(io.current?.tasks.find(task => task.id === 1)?.taken).toBe(2)
})

test('a finish_task whose taken commits git cannot count keeps no count', async () => {
  const io = ioWith(backlog())
  io.answers[`git rev-list --count --no-merges ${HEAD}..${FULL}`] = '5'
  io.failing.push(`git rev-list --count --no-merges --first-parent ${HEAD}..${FULL}`)
  await serveTool(io, call(FINISH_1))
  expect(io.current?.tasks.find(task => task.id === 1)).not.toHaveProperty('taken')
})

test('two finish_task calls at once merge one at a time, each the commit of its own task', async () => {
  const io = ioWith(runOf(claimTask(planned(), 'w2', 2, 1, NOW)))
  await Promise.all([serveTool(io, call(FINISH_1)), serveTool(io, call(FINISH_2))])
  expect(merges(io)).toEqual([...MERGE_1, ...MERGE_2])
  expect(io.current?.line).toEqual({ head: TOGGLE, tasks: [1, 2] })
})
