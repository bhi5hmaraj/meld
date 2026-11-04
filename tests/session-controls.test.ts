import { expect, test } from 'claude-code/testing'
import type { ToolCallInput } from 'claude-code'

import { controlRun, guardCall, serveTool } from '../core/actions'
import { bindWorker, declareFinal, isFailure, startRun as startBoard, stopRun, takeIntegration } from '../core/board'
import { COMMAND_CONTROLS, SESSION_TOOLS, TOOL, TOOL_SPECS } from '../core/contract'
import type { AgentSpec, Change, Run, VcsKind, WorkerId } from '../types'
import { FakeIo, HEAD } from './fake-io'
import { STORED_BY_0_7_0 } from './stored-runs'

const NOW = 1_800_000_000_000
const FULL = 'f'.repeat(40)
const LINE_HEAD = 'a'.repeat(40)
const WORKER: AgentSpec = { type: 'meld:worker' }
const NO_RUN_AT_WORK = 'There is no meld run at work. A worker can join a run that starts or works.'

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

function working(count = 2, vcs: VcsKind = 'git'): Run {
  const ids = Array.from({ length: count }, (_, index) => `w${index + 1}` as WorkerId)
  const workers = ids.map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: vcs === 'jj' ? `${id}@` : `meld/r1/${id}`, agent: WORKER }))
  let run = startBoard({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs, now: NOW, workers })
  for (const [index, id] of ids.entries()) run = runOf(bindWorker(run, id, `agent-${index + 1}`, NOW))
  return run
}

function ready(): Run {
  return runOf(declareFinal(runOf(takeIntegration(working(1), 'w1', NOW)), 'w1', FULL, 'A dark theme', NOW))
}

function ioWith(run: Run | null): FakeIo {
  const io = new FakeIo()
  io.current = run
  return io
}

function call(input: Record<string, unknown>): ToolCallInput {
  return input as unknown as ToolCallInput
}

function parsed(result: unknown): unknown {
  if (typeof result !== 'string') throw new Error(`a tool result is a string, not ${typeof result}`)
  return JSON.parse(result)
}

test('the main session delivers a ready run with the deliver tool', async () => {
  const io = ioWith(ready())
  const replied = await serveTool(io, call({ tool: TOOL.deliver }))
  expect(parsed(replied.result)).toEqual({ text: `Merged ${FULL.slice(0, 7)} into your branch.` })
  expect(io.current?.state).toBe('delivered')
})

test('the main session discards a run with the discard tool', async () => {
  const io = ioWith(working())
  const replied = await serveTool(io, call({ tool: TOOL.discard }))
  expect(parsed(replied.result)).toEqual({ text: 'The run and its workspaces are gone.' })
  expect(io.current).toBeNull()
  expect(io.commands).toContain('rm -rf -- /tmp/meld/r1')
})

test('a worker cannot deliver, discard or add a worker', async () => {
  for (const tool of [TOOL.deliver, TOOL.discard, TOOL.addWorker]) {
    const io = ioWith(ready())
    const replied = await serveTool(io, call({ tool, agentId: 'agent-1' }))
    expect(parsed(replied.result)).toMatchObject({ error: 'NOT_ALLOWED' })
    expect(io.current?.state).toBe('ready')
    expect(io.current?.workers).toHaveLength(1)
  }
})

test('a new worker gets the next id, a workspace from the base and an agent', async () => {
  const io = ioWith(working(2))
  const replied = await serveTool(io, call({ tool: TOOL.addWorker }))
  expect(parsed(replied.result)).toEqual({ text: 'w3 joined the run. Its workspace is /tmp/meld/r1/w3, from the base.' })
  expect(io.commands).toContain(`git worktree add -b meld/r1/w3 /tmp/meld/r1/w3 ${HEAD}`)
  expect(io.current?.workers.map(worker => worker.id)).toEqual(['w1', 'w2', 'w3'])
  expect(io.current?.workers[2]).toMatchObject({ path: '/tmp/meld/r1/w3', ref: 'meld/r1/w3', agent: WORKER, agentId: 'spawned-1' })
  expect(io.spawned[0]?.cwd).toBe('/tmp/meld/r1/w3')
})

test('with an integration line, a new worker starts from its head', async () => {
  const io = ioWith({ ...working(2), line: { head: LINE_HEAD, tasks: [] } })
  const replied = await serveTool(io, call({ tool: TOOL.addWorker }))
  expect(parsed(replied.result)).toEqual({ text: 'w3 joined the run. Its workspace is /tmp/meld/r1/w3, from the integration line.' })
  expect(io.commands).toContain(`git worktree add -b meld/r1/w3 /tmp/meld/r1/w3 ${LINE_HEAD}`)
})

test('on jj, a new worker starts from the head of the line, or from the base with no line', async () => {
  const lined = ioWith({ ...working(2, 'jj'), line: { head: LINE_HEAD, tasks: [] } })
  await serveTool(lined, call({ tool: TOOL.addWorker }))
  expect(lined.commands).toContain(`jj -R /tmp/meld/r1/jj workspace add --name w3 -r ${LINE_HEAD} /tmp/meld/r1/w3`)
  const plain = ioWith(working(2, 'jj'))
  await serveTool(plain, call({ tool: TOOL.addWorker }))
  expect(plain.commands).toContain('jj -R /tmp/meld/r1/jj workspace add --name w3 -r meld_base /tmp/meld/r1/w3')
  expect(plain.current?.workers[2]?.ref).toBe('w3@')
})

test('a new worker takes the agent type and the model that the person names', async () => {
  const io = ioWith(working(2))
  await serveTool(io, call({ tool: TOOL.addWorker, agent: 'general-purpose@haiku' }))
  expect(io.current?.workers[2]?.agent).toEqual({ type: 'general-purpose', model: 'haiku' })
})

test('with no agent named, a new worker takes the agent of w1', async () => {
  const run = working(2)
  const io = ioWith({ ...run, workers: run.workers.map(worker => ({ ...worker, agent: { type: 'meld:worker', model: 'opus' } })) })
  await serveTool(io, call({ tool: TOOL.addWorker }))
  expect(io.current?.workers[2]?.agent).toEqual({ type: 'meld:worker', model: 'opus' })
})

test('a run has 8 workers at most', async () => {
  const io = ioWith(working(8))
  const replied = await serveTool(io, call({ tool: TOOL.addWorker }))
  expect(parsed(replied.result)).toEqual({ text: 'A run has 8 workers at most.' })
  expect(io.commands.filter(command => command.includes('worktree add'))).toEqual([])
})

test('a ready, stopped or missing run takes no new worker', async () => {
  for (const run of [ready(), stopRun(working(), NOW), null]) {
    const io = ioWith(run)
    const replied = await serveTool(io, call({ tool: TOOL.addWorker }))
    expect(parsed(replied.result)).toEqual({ text: NO_RUN_AT_WORK })
    expect(io.spawned).toHaveLength(0)
  }
})

test('a worker whose agent does not start stays on the board, with the reason', async () => {
  const io = ioWith(working(2))
  io.spawnDeny = 'the agent type is unknown'
  const replied = await serveTool(io, call({ tool: TOOL.addWorker, agent: 'NoSuchType' }))
  expect(parsed(replied.result)).toEqual({ text: 'w3 joined the run, but its agent did not start: the agent type is unknown.' })
  expect(io.current?.workers[2]?.id).toBe('w3')
})

test('a run stored by meld 0.7.0 takes a new worker', async () => {
  const io = ioWith(STORED_BY_0_7_0)
  const replied = await serveTool(io, call({ tool: TOOL.addWorker }))
  const next = `w${STORED_BY_0_7_0.workers.length + 1}`
  expect(parsed(replied.result)).toEqual({ text: `${next} joined the run. Its workspace is /tmp/meld/${STORED_BY_0_7_0.id}/${next}, from the base.` })
})

test('each control command does what its tool does', async () => {
  expect(COMMAND_CONTROLS).toEqual({ 'meld-steer': 'steer', 'meld-stop': 'stop', 'meld-deliver': 'deliver', 'meld-discard': 'discard', 'meld-add': 'add_worker' })
  const io = ioWith(working(2))
  expect(await controlRun(io, COMMAND_CONTROLS['meld-add'], 'opus')).toBe('w3 joined the run. Its workspace is /tmp/meld/r1/w3, from the base.')
  expect(io.current?.workers[2]?.agent).toEqual({ type: 'meld:worker', model: 'opus' })
})

test('each session tool says that only the main session uses it', () => {
  for (const tool of SESSION_TOOLS) {
    const spec = TOOL_SPECS.find(one => `mcp__meld__${one.name}` === tool)
    expect(spec?.description).toContain('Only the main session')
  }
})

test('a worker that still runs after a discard gets no tool call through: the guard tells it to end its turn', async () => {
  const io = ioWith(working(2))
  await controlRun(io, 'discard')
  const denied = await guardCall(io, call({ tool: 'Edit', file_path: '/repo/src/a.ts', agentId: 'agent-1' }))
  expect(denied).toBe('meld stopped you. End your turn now with a one-line summary.')
})

test('a stop of the run while meld starts a new worker leaves its agent nothing to do: it hears to end its turn, and the guard refuses its calls', async () => {
  const io = ioWith(working(2))
  io.during['meld w3'] = run => stopRun(run, NOW)
  await controlRun(io, 'add_worker', '')
  const denied = await guardCall(io, call({ tool: 'Edit', file_path: '/repo/src/a.ts', agentId: 'spawned-1' }))
  expect(io.sent).toContain('spawned-1: meld stopped you. End your turn now.')
  expect(denied).toBe('meld stopped you. End your turn now with a one-line summary.')
})
