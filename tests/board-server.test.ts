import { expect, test } from 'claude-code/testing'
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
type Row = { run: Run | null; version: number; owner: string | null; ownerAt: number | null }

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
    if (tool === 'read_board') return { ...row, facts: null }
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
    return { ok: true }
  }
}

/** What the engine answers for a session start; with a FakeMcp, meld mcp connects, and without one it does not start. */
function answerTheEngine(on: On, mcp: FakeMcp | undefined): void {
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('session.id', () => ({ value: SESSION }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.register', ($, e) => ({ value: { tool: e.name } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.register', ($, e) => ({ value: { agent: e.name } }))
  on('mcp.connect', () => ({ value: mcp ? { isConnected: true, server: SERVER } : { isConnected: false, reason: 'failed', message: 'bun: not found' } }))
  if (mcp) on('mcp.call', ($, e) => ({ value: mcp.answer(e.tool, e.args) }))
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

test('a model call of a tool of the board store is refused, as only meld calls it', async ($, on) => {
  answerTheEngine(on, new FakeMcp())
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  const called = await $.tool.call({ tool: 'mcp__plugin_meld_board__commit_board', board: SESSION, run: null, version: 0, owner: 'model' } as never)
  expect(called).toEqual({ deny: 'Only meld calls the board store of meld mcp.' })
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
