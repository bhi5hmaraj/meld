import { expect, test } from 'claude-code/testing'

import { acpRefusal, ownedByAcp, recordActivity, restartIdleWorkers } from '../core/actions'
import { addTasks, bindWorker, isFailure, setWorkerState, startRun, stopWorker } from '../core/board'
import { acpCommandOf, formatStart, parseStart } from '../core/options'
import type { Change, Run, WorkerId } from '../types'
import { FakeIo, HEAD } from './fake-io'

const NOW = 1_800_000_000_000
const IDS: WorkerId[] = ['w1', 'w2']

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

/** w1 runs as the Claude subagent agent-1, and w2 as the Codex agent acp-2 of meld mcp. */
function mixed(): Run {
  const workers = IDS.map((id, index) => ({ id, path: `/tmp/meld/r1/${id}`, ref: `meld/r1/${id}`, agent: { type: index === 0 ? 'meld:worker' : 'acp:codex' } }))
  const run = startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers })
  return runOf(bindWorker(runOf(bindWorker(run, 'w1', 'agent-1', NOW)), 'w2', 'acp-2', NOW))
}

function idleWithTasks(): Run {
  const run = mixed()
  const tasked = runOf(addTasks(run, 'w1', { seen: run.taskList, tasks: [{ title: 'Add the theme' }, { title: 'Add the toggle' }] }, NOW))
  return setWorkerState(setWorkerState(tasked, 'w1', 'idle', NOW), 'w2', 'idle', NOW)
}

/** A FakeIo that counts the writes of the run. */
class CountingIo extends FakeIo {
  writes = 0

  override async write(change: (run: Run | null) => Run | null): Promise<Run | null> {
    this.writes += 1
    return super.write(change)
  }
}

function ioWith(run: Run): FakeIo {
  const io = new FakeIo()
  io.current = run
  io.now = async () => NOW + 60_000
  return io
}

test('codex in --agents is the ACP agent codex, which runs through the codex-acp adapter', () => {
  const options = parseStart('--agents codex,opus Add a dark theme')
  expect(options).toMatchObject({ agents: [{ type: 'acp:codex' }, { type: 'meld:worker', model: 'opus' }] })
  expect(formatStart({ request: 'Add a dark theme', agents: [{ type: 'acp:codex' }], vcs: 'git' })).toBe('--agents acp:codex --vcs git Add a dark theme')
  expect(acpCommandOf({ type: 'acp:codex' })).toEqual(['npx', '-y', '@agentclientprotocol/codex-acp'])
  expect(acpCommandOf({ type: 'meld:worker' })).toBeUndefined()
})

test('gemini and cursor in --agents are the ACP modes of the Gemini CLI and of the agent of Cursor', () => {
  expect(parseStart('--agents gemini,cursor Add a dark theme')).toMatchObject({ agents: [{ type: 'acp:gemini' }, { type: 'acp:cursor' }] })
  expect(acpCommandOf({ type: 'acp:gemini' })).toEqual(['npx', '-y', '@google/gemini-cli', '--acp'])
  expect(acpCommandOf({ type: 'acp:cursor' })).toEqual(['agent', 'acp'])
})

test('the plugin starts only the workers of its engine again, and meld mcp only its ACP workers, so no worker gets two agents', async () => {
  const acp = ioWith(idleWithTasks())
  await restartIdleWorkers(acp, ownedByAcp)
  expect(acp.spawned.map(spawn => [spawn.description, spawn.subagentType])).toEqual([['meld w2', 'acp:codex']])
  const plugin = ioWith(idleWithTasks())
  await restartIdleWorkers(plugin)
  expect(plugin.spawned.map(spawn => [spawn.description, spawn.subagentType])).toEqual([['meld w1', 'meld:worker']])
})

test('a beat with no ended agent and no work for an idle worker writes nothing', async () => {
  const io = new CountingIo()
  io.current = mixed()
  io.agentStates = new Map([
    ['agent-1', 'live'],
    ['acp-2', 'live'],
  ])
  await restartIdleWorkers(io, ownedByAcp)
  await restartIdleWorkers(io)
  expect(io.writes).toBe(0)
})

test('meld mcp settles only its ACP workers, as it knows only the agents that it runs', async () => {
  const acp = ioWith(mixed())
  acp.agentStates = new Map([['acp-2', 'ended']])
  await restartIdleWorkers(acp, ownedByAcp)
  expect(acp.current?.workers.map(worker => worker.state)).toEqual(['working', 'idle'])
})

test('an ACP permission ask is refused for an edit outside the folder of the worker, for a stopped worker, and after the final', async () => {
  const io = ioWith(mixed())
  expect(await acpRefusal(io, 'acp-2', { kind: 'edit', paths: ['/repo/src/theme.ts'] })).toBe('meld: you work in /tmp/meld/r1/w2. Edit /tmp/meld/r1/w2/src/theme.ts instead.')
  expect(await acpRefusal(io, 'acp-2', { kind: 'edit', paths: ['/tmp/meld/r1/w2/src/theme.ts'] })).toBeUndefined()
  expect(await acpRefusal(io, 'acp-2', { kind: 'execute', paths: [] })).toBeUndefined()
  io.current = stopWorker(mixed(), 'w2', NOW)
  expect(await acpRefusal(io, 'acp-2', { kind: 'execute', paths: [] })).toContain('meld stopped you')
  io.current = { ...mixed(), state: 'ready' }
  expect(await acpRefusal(io, 'acp-2', { kind: 'read', paths: [] })).toContain('has its final commit')
})

test('an ACP tool call becomes the activity of its worker, and counts as a call', async () => {
  const io = ioWith(mixed())
  await recordActivity(io, 'acp-2', 'Edit theme.ts')
  expect(io.current?.workers[1]).toMatchObject({ activity: 'Edit theme.ts', activityAt: NOW + 60_000, calls: 1 })
})
