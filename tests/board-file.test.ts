import { expect, test } from 'claude-code/testing'
import type { ToolCallInput } from 'claude-code'

import { deliver, guardCall, serveTool, startRun, steerRun } from '../core/actions'
import { bindWorker, declareFinal, isFailure, startRun as startBoard, takeIntegration } from '../core/board'
import type { AgentSpec, Change, Run, WorkerId } from '../types'
import { FakeIo, HEAD, SessionStateIo } from './fake-io'

const NOW = 1_800_000_000_000
const ID = `${NOW.toString(36)}0000`
const FULL = 'f'.repeat(40)
const WORKER: AgentSpec = { type: 'meld:worker' }
const RECORD = '/tmp/meld/r1/board.json'
const FACT = 'The tokens are in src/theme.css.'

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

function working(): Run {
  const ids: WorkerId[] = ['w1', 'w2']
  const workers = ids.map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: `meld/r1/${id}`, agent: WORKER }))
  let run = startBoard({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers })
  for (const [index, id] of ids.entries()) run = runOf(bindWorker(run, id, `agent-${index + 1}`, NOW))
  return run
}

function sessionState(run: Run | null): SessionStateIo {
  const io = new SessionStateIo()
  io.current = run
  return io
}

function recordOf(io: FakeIo, path = RECORD): Run | undefined {
  const text = io.files[path]
  return text === undefined ? undefined : (JSON.parse(text) as Run)
}

function call(input: Record<string, unknown>): ToolCallInput {
  return input as unknown as ToolCallInput
}

test('with meld mcp the store keeps the run, so meld writes no board.json', async () => {
  const io = new FakeIo()
  await startRun(io, '/repo', { request: 'Add a dark theme', agents: [WORKER, WORKER], vcs: 'git' })
  expect(io.current?.id).toBe(ID)
  expect(io.fileWrites.filter(path => path.endsWith('/board.json'))).toEqual([])
})

test('in the session state, a new run writes its record to board.json in the folder of the run', async () => {
  const io = sessionState(null)
  await startRun(io, '/repo', { request: 'Add a dark theme', agents: [WORKER, WORKER], vcs: 'git' })
  expect(recordOf(io, `/tmp/meld/${ID}/board.json`)).toEqual(io.current ?? undefined)
})

test('board.json holds the run of the newest write, with its context', async () => {
  const io = sessionState(working())
  await serveTool(io, call({ tool: 'mcp__meld__share', kind: 'fact', text: FACT, agentId: 'agent-1' }))
  await serveTool(io, call({ tool: 'mcp__meld__board', agentId: 'agent-2' }))
  expect(recordOf(io)?.context?.map(entry => [entry.kind, entry.text, entry.seenBy])).toEqual([['fact', FACT, ['w2']]])
  expect(recordOf(io)).toEqual(io.current ?? undefined)
})

test('a guarded tool call and a steer update board.json', async () => {
  const io = sessionState(working())
  await guardCall(io, call({ tool: 'Bash', command: 'pnpm test', agentId: 'agent-1' }))
  expect(recordOf(io)?.workers[0]?.activity).toBe('Bash: pnpm test')
  await steerRun(io, 'Use the brand colours')
  expect(recordOf(io)?.revision).toBe(2)
})

test('a write that leaves the run as it was writes no board.json', async () => {
  const io = sessionState(working())
  await io.write(run => run && { ...run })
  expect(io.fileWrites).toEqual([])
})

test('a board.json that cannot be written fails no board call', async () => {
  const io = sessionState(working())
  io.unwritable = [RECORD]
  const replied = await serveTool(io, call({ tool: 'mcp__meld__share', kind: 'fact', text: FACT, agentId: 'agent-1' }))
  expect(JSON.parse(replied.result)).toMatchObject({ ok: true })
  expect(io.current?.context).toHaveLength(1)
})

test('deliver writes no board.json into the folder that it removed', async () => {
  const io = sessionState(runOf(declareFinal(runOf(takeIntegration(working(), 'w2', NOW)), 'w2', FULL, 'Done', NOW)))
  await deliver(io)
  expect(io.current?.state).toBe('delivered')
  expect(io.files[RECORD]).toBeUndefined()
})
