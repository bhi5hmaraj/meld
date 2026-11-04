import { expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { McpToolResult, On } from 'claude-code'

import { bindWorker, isFailure, startRun } from '../core/board'
import type { Change, Run, WorkerId } from '../types'
import { HEAD } from './fake-io'

const NOW = 1_800_000_000_000
const SERVER = 'plugin:meld:board'
const SESSION = 'session-1'
const IDS: WorkerId[] = ['w1', 'w2']
const TYPED = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }

type Call = { tool: string; args: Record<string, unknown> }
type Action = { id: number; board: string; kind: 'send' | 'toast'; agent: string; text: string; at: number }
type Row = { run: Run | null; version: number; owner: string | null; ownerAt: number | null }

function gitAnswer(argv: readonly string[]): { value: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean } } {
  const command = argv.join(' ')
  const stdout = command === 'git rev-parse --show-toplevel' ? '/repo' : command === 'git rev-parse HEAD' ? HEAD : command === 'git version' ? 'git version 2.43.0' : ''
  return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

function working(id = 'r1'): Run {
  const workers = IDS.map(worker => ({ id: worker, path: `/tmp/meld/${id}/${worker}`, ref: `meld/${id}/${worker}`, agent: { type: 'meld:worker' } }))
  let run = startRun({ id, request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers })
  for (const [index, worker] of IDS.entries()) run = runOf(bindWorker(run, worker, `agent-${index + 1}`, NOW))
  return run
}

/** meld mcp as the plugin calls it: boards with versions and owners, and each call recorded. */
class FakeMcp {
  boards: Record<string, Row> = {}
  calls: Call[] = []
  actions: Action[] = []

  answer(tool: string, args: Record<string, unknown>): McpToolResult {
    this.calls.push({ tool, args })
    return { content: [{ type: 'text', text: JSON.stringify(this.value(tool, args)) }], isError: false }
  }

  boardsOf(tool: string): string[] {
    return this.calls.filter(call => call.tool === tool).map(call => String(call.args.board))
  }

  private value(tool: string, args: Record<string, unknown>): unknown {
    const id = String(args.board)
    const row = this.boards[id] ?? { run: null, version: 0, owner: null, ownerAt: null }
    if (tool === 'read_board') return row
    if (tool === 'commit_board') {
      if (args.version !== row.version) return { result: 'stale' }
      this.boards[id] = { run: args.run as Run | null, version: row.version + 1, owner: String(args.owner), ownerAt: NOW }
      return { result: 'committed' }
    }
    if (tool === 'list_boards') {
      return { boards: Object.entries(this.boards).flatMap(([board, one]) => (one.run ? [{ board, run: one.run.id, state: one.run.state, request: one.run.request, repo: one.run.repo, owner: one.owner, ownerAt: one.ownerAt }] : [])) }
    }
    if (tool === 'adopt_board') {
      if (!row.run) return { result: 'missing' }
      this.boards[id] = { ...row, owner: String(args.owner), ownerAt: NOW, version: row.version + 1 }
      return { result: 'adopted' }
    }
    if (tool === 'spawn_worker') return { agentId: 'acp-1' }
    if (tool === 'send_worker') return { ok: true }
    if (tool === 'acp_agents') return { agents: {} }
    if (tool === 'take_actions') return { actions: this.actions.splice(0) }
    throw new Error(`meld mcp has no tool ${tool}`)
  }
}

/** What the engine answers for a session start; with a FakeMcp, meld mcp connects, and without one it does not start. */
function answerTheEngine(on: On, mcp: FakeMcp | undefined): MockClock {
  const clock = mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: SESSION }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.register', ($, e) => ({ value: { tool: e.name } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.register', ($, e) => ({ value: { agent: e.name } }))
  on('mcp.connect', () => ({ value: mcp ? { isConnected: true, server: SERVER } : { isConnected: false, reason: 'failed', message: 'bun: not found' } }))
  if (mcp) on('mcp.call', ($, e) => ({ value: mcp.answer(e.tool, e.args) }))
  return clock
}

test('with meld mcp, a command reads and commits the run on the board of the session', async ($, on) => {
  const mcp = new FakeMcp()
  answerTheEngine(on, mcp)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  mcp.boards[SESSION] = { run: working(), version: 4, owner: SESSION, ownerAt: NOW }
  const replied = await $.command.run({ command: 'meld-stop', args: '', ...TYPED })
  expect(replied.text).toContain('Stopped.')
  expect(mcp.boards[SESSION]?.run?.state).toBe('stopped')
  expect(mcp.boards[SESSION]?.version).toBe(5)
})

test('the session state gets each run that the board commits, as the pane draws from it', async ($, on) => {
  const mcp = new FakeMcp()
  const cached: string[] = []
  answerTheEngine(on, mcp)
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('state.set', ($, e) => {
    if (e.key === 'run') cached.push(String((e.value as { value?: Run } | undefined)?.value?.state))
    return { value: { isSet: true, version: 1 } }
  })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  mcp.boards[SESSION] = { run: working(), version: 1, owner: SESSION, ownerAt: NOW }
  await $.command.run({ command: 'meld-stop', args: '', ...TYPED })
  expect(cached.at(-1)).toBe('stopped')
})

test('the timer of the pane reads the run from the session state and calls no tool of meld mcp, as the engine asks the person for each call of a timer', async ($, on) => {
  const mcp = new FakeMcp()
  const clock = answerTheEngine(on, mcp)
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  mcp.boards[SESSION] = { run: working(), version: 1, owner: SESSION, ownerAt: NOW }
  await clock.advance(10_000)
  expect(mcp.calls).toEqual([])
})

test('without meld mcp, a command keeps the run in the session state, as meld 0.8 does', async ($, on) => {
  const written: string[] = []
  answerTheEngine(on, undefined)
  on('state.get', ($, e) => ({ value: e.key === 'run' ? { value: { shape: 'run-4', value: working() }, version: 1 } : { value: undefined, version: 0 } }))
  on('state.set', ($, e) => {
    written.push(`${e.key} ${String((e.value as { value?: Run } | undefined)?.value?.state)}`)
    return { value: { isSet: true, version: 2 } }
  })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  const replied = await $.command.run({ command: 'meld-stop', args: '', ...TYPED })
  expect(replied.text).toContain('Stopped.')
  expect(written).toContain('run stopped')
})

test('the permission check refuses a model call of a tool of the board store, as only meld calls it', async ($, on) => {
  answerTheEngine(on, new FakeMcp())
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  const checked = await $.tool.check({ tool: 'mcp__plugin_meld_board__commit_board', input: { board: SESSION, run: null, version: 0, owner: 'model' } })
  expect(checked).toEqual({ decision: 'deny', reason: 'Only meld calls the board store of meld mcp.' })
})

test('/meld-resume lists the run of another session from meld mcp, and a resume moves this session to that board', async ($, on) => {
  const mcp = new FakeMcp()
  const pointed: unknown[] = []
  answerTheEngine(on, mcp)
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('state.set', ($, e) => {
    if (e.key === 'board') pointed.push((e.value as { value?: unknown } | undefined)?.value)
    return { value: { isSet: true, version: 1 } }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.usage', () => ({ value: { startedAt: NOW, cost: { usd: 1.25 } } as never }))
  on('agent.list', () => ({ value: [] }))
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  mcp.boards['old-session'] = { run: working('r0'), version: 7, owner: 'old-session', ownerAt: NOW - 10 * 60_000 }
  const listed = await $.command.run({ command: 'meld-resume', args: '', ...TYPED })
  expect(listed.text).toContain('- old-session: run r0, working, "Add a dark theme" in /repo, last write 10 min ago')
  const resumed = await $.command.run({ command: 'meld-resume', args: 'old-session', ...TYPED })
  expect(resumed.text).toContain('Resumed run r0')
  expect(pointed).toEqual(['old-session'])
  expect(mcp.boards['old-session']).toMatchObject({ owner: SESSION })
  expect(mcp.boards['old-session']?.run?.costAtStart).toBe(1.25)
  await $.command.run({ command: 'meld-stop', args: '', ...TYPED })
  expect(mcp.boards['old-session']?.run?.state).toBe('stopped')
})

test('a start with a codex worker asks meld mcp to start it in its folder, and binds the worker to its agent', async ($, on) => {
  const mcp = new FakeMcp()
  answerTheEngine(on, mcp)
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('state.set', () => ({ value: { isSet: true, version: 1 } }))
  on('process.run', ($, e) => gitAnswer(e.argv))
  on('session.usage', () => ({ value: { startedAt: NOW, cost: { usd: 0 } } as never }))
  on('agent.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'a test draws no pane' } }))
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  const replied = await $.command.run({ command: 'meld', args: '--agents codex --vcs git Add a greeting', ...TYPED })
  expect(replied.text).toContain('workers on git')
  const spawn = mcp.calls.find(call => call.tool === 'spawn_worker')
  expect(spawn?.args).toMatchObject({ board: SESSION, subagentType: 'acp:codex', description: 'meld w1' })
  expect(String(spawn?.args.cwd)).toMatch(/^\/tmp\/meld\/[0-9a-z]+\/w1$/)
  expect(mcp.boards[SESSION]?.run?.workers[0]?.agentId).toBe('acp-1')
})

test('at the end of a turn, the plugin carries out what workers of meld mcp left: a message to a subagent, and a toast', async ($, on) => {
  const mcp = new FakeMcp()
  const sent: string[] = []
  const toasts: string[] = []
  answerTheEngine(on, mcp)
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('state.set', () => ({ value: { isSet: true, version: 1 } }))
  on('agent.list', () => ({ value: [] }))
  on('session.send', ($, e) => {
    sent.push(`${e.to}: ${e.text}`)
    return { isDelivered: true as const }
  })
  on('ui.toast', ($, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  mcp.boards[SESSION] = { run: working(), version: 1, owner: SESSION, ownerAt: NOW }
  mcp.actions = [
    { id: 1, board: SESSION, kind: 'send', agent: 'agent-2', text: 'There is open work on the board.', at: NOW },
    { id: 2, board: SESSION, kind: 'toast', agent: '', text: 'meld: the result is ready.', at: NOW },
  ]
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(sent).toEqual(['agent-2: There is open work on the board.'])
  expect(toasts).toEqual(['meld: the result is ready.'])
})
