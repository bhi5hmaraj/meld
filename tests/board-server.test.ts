import { expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { McpToolResult, On, TurnUsage } from 'claude-code'

import { addTasks, bindWorker, CONTEXT_CAP, isFailure, setWorkerState, startRun } from '../core/board'
import type { RunRecord } from '../core/ports'
import type { Change, Run, WorkerId } from '../types'
import { HEAD } from './fake-io'

const NOW = 1_800_000_000_000
const SERVER = 'plugin:meld:board'
const SESSION = 'session-1'
const IDS: WorkerId[] = ['w1', 'w2']
const CHANNEL = '/tmp/meld/channels/1.sock'
const WINDOW = 200_000
const USAGE = { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 30_000, output_tokens: 500, model: 'claude-opus-5-5' } as TurnUsage
const STORED = { shape: 'run-5' }
/** The offer of the worker type, as the engine checks it before it resumes an agent of that type. */
const WORKER_OFFER = { agent: 'meld:worker', description: 'A meld worker.', source: 'plugin', provider: { plugin: 'meld', tier: 'user' as const } }
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

function withActivity(run: Run, worker: WorkerId, activity: string): Run {
  return { ...run, workers: run.workers.map(one => (one.id === worker ? { ...one, activity } : one)) }
}

/** w1 idle with a context that fills a fifth of the window of its agent, and w2 working: two open tasks, so one is for w1. */
function idleWithSmallContext(): Run {
  const run = working()
  const tasked = runOf(addTasks(run, 'w2', { seen: run.taskList, tasks: [{ title: 'Add the theme' }, { title: 'Add the toggle' }] }, NOW))
  const idle = setWorkerState(tasked, 'w1', 'idle', NOW)
  return { ...idle, workers: idle.workers.map(worker => (worker.id === 'w1' ? { ...worker, context: { used: 40_000, size: WINDOW } } : worker)) }
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
  records: RunRecord[] = []
  calls: Call[] = []
  actions: Action[] = []
  channel = CHANNEL

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
    if (tool === 'run_records') return { runs: this.records }
    if (tool === 'board_channel') return { socketPath: this.channel }
    if (tool === 'lead_board') return { ok: true }
    if (tool === 'spawn_worker') return { agentId: 'acp-1' }
    if (tool === 'send_worker') return { ok: true }
    if (tool === 'acp_agents') return { agents: {} }
    if (tool === 'take_actions') return { actions: this.actions.splice(0) }
    throw new Error(`meld mcp has no tool ${tool}`)
  }
}

/** What the engine answers for a session start; with a FakeMcp, meld mcp connects, and without one it does not start. */
function answerTheEngine(on: On, mcp: FakeMcp | undefined, agents: { name: string; autoCompactWindow?: number }[] = []): MockClock {
  const clock = mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: SESSION }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.register', ($, e) => ({ value: { tool: e.name } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.register', ($, e) => {
    agents.push({ name: e.name, autoCompactWindow: e.autoCompactWindow })
    return { value: { agent: e.name } }
  })
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

test('the timer of the pane calls no tool of meld mcp, as the engine asks the person for each call of a timer; without a channel it fetches nothing', async ($, on) => {
  const mcp = new FakeMcp()
  const fetched: string[] = []
  mcp.channel = ''
  const clock = answerTheEngine(on, mcp)
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('http.fetch', ($, e) => {
    fetched.push(e.url)
    return { value: { status: 404, ok: false, headers: {}, text: '' } }
  })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  const started = mcp.calls.length
  mcp.boards[SESSION] = { run: working(), version: 1, owner: SESSION, ownerAt: NOW }
  await clock.advance(10_000)
  expect(mcp.calls.slice(started)).toEqual([])
  expect(fetched).toEqual([])
})

test('the timer of the pane reads the board over the channel of meld mcp, so the session state gets what ACP workers wrote', async ($, on) => {
  const mcp = new FakeMcp()
  const fetched: string[] = []
  const copied: (string | undefined)[] = []
  const clock = answerTheEngine(on, mcp)
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('state.set', ($, e) => {
    if (e.key === 'run') copied.push((e.value as { value?: Run } | undefined)?.value?.workers[1]?.activity)
    return { value: { isSet: true, version: 1 } }
  })
  on('http.fetch', ($, e) => {
    fetched.push(`${e.url} over ${e.init?.socketPath}`)
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(mcp.boards[SESSION]) } }
  })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  const started = mcp.calls.length
  mcp.boards[SESSION] = { run: withActivity(working(), 'w2', 'Edit /tmp/meld/r1/w2/a.txt'), version: 3, owner: SESSION, ownerAt: NOW }
  await clock.advance(3000)
  expect(fetched).toEqual([`http://meld/boards/${SESSION} over ${CHANNEL}`])
  expect(copied).toEqual(['Edit /tmp/meld/r1/w2/a.txt'])
  expect(mcp.calls.slice(started)).toEqual([])
})

test('the timer keeps the copy of the run when the channel does not answer the board', async ($, on) => {
  const mcp = new FakeMcp()
  const copied: string[] = []
  const clock = answerTheEngine(on, mcp)
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('state.set', ($, e) => {
    copied.push(e.key)
    return { value: { isSet: true, version: 1 } }
  })
  on('http.fetch', () => ({ value: { status: 503, ok: false, headers: {}, text: 'meld mcp is closing' } }))
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await clock.advance(3000)
  expect(copied).not.toContain('run')
})

test('without meld mcp, a command keeps the run in the session state, as meld 0.8 does', async ($, on) => {
  const written: string[] = []
  answerTheEngine(on, undefined)
  on('state.get', ($, e) => ({ value: e.key === 'run' ? { value: { shape: 'run-5', value: working() }, version: 1 } : { value: undefined, version: 0 } }))
  on('state.set', ($, e) => {
    written.push(`${e.key} ${String((e.value as { value?: Run } | undefined)?.value?.state)}`)
    return { value: { isSet: true, version: 2 } }
  })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  const replied = await $.command.run({ command: 'meld-stop', args: '', ...TYPED })
  expect(replied.text).toContain('Stopped.')
  expect(written).toContain('run stopped')
})

test('without meld mcp, a command keeps the run in the session state alone, and writes no board.json', async ($, on) => {
  const paths: string[] = []
  let stored: unknown = { ...STORED, value: working() }
  answerTheEngine(on, undefined)
  on('state.get', ($, e) => ({ value: e.key === 'run' ? { value: stored, version: 1 } : { value: undefined, version: 0 } }))
  on('state.set', ($, e) => {
    if (e.key === 'run') stored = e.value
    return { value: { isSet: true, version: 2 } }
  })
  on('fs.write', ($, e) => {
    paths.push(e.path)
    return { value: undefined }
  })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await $.command.run({ command: 'meld-stop', args: '', ...TYPED })
  expect((stored as { value: Run }).value.state).toBe('stopped')
  expect(paths).toEqual([])
})

test('with meld mcp, /meld-clean reads the run of a folder from the record that meld mcp keeps, and removes it with its branches', async ($, on) => {
  const mcp = new FakeMcp()
  mcp.records = [{ id: 'abc', board: 'session-0', state: 'stopped', vcs: 'git', repo: '/repo', base: HEAD, workers: ['w1', 'w2'], changedAt: NOW - 2 * 86_400_000 }]
  answerTheEngine(on, mcp)
  on('fs.list', ($, e) => {
    if (e.path === '/tmp/meld') return { value: [{ name: 'abc', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }
    throw new Error(`ENOENT: ${e.path}`)
  })
  const ran: string[] = []
  on('process.run', ($, e) => {
    ran.push(e.argv.join(' '))
    return gitAnswer(e.argv)
  })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  const listed = await $.command.run({ command: 'meld-clean', args: '', ...TYPED })
  expect(listed.text).toContain('abc: stopped, changed 2 d ago')
  expect(mcp.calls.map(call => call.tool)).toContain('run_records')
  await $.command.run({ command: 'meld-clean', args: 'abc', ...TYPED })
  expect(ran).toEqual(expect.arrayContaining(['rm -rf -- /tmp/meld/abc', 'git branch -D meld/abc/w2']))
})

test('at its start, the plugin makes its meld mcp the leader of the ACP workers of the board of the session', async ($, on) => {
  const mcp = new FakeMcp()
  answerTheEngine(on, mcp)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  expect(mcp.calls.filter(call => call.tool === 'lead_board').map(call => call.args)).toEqual([{ board: SESSION, owner: SESSION }])
})

test('a model call of a subagent records the context of its worker, against the window of the model of the session', async ($, on) => {
  const written: (Run | undefined)[] = []
  answerTheEngine(on, undefined)
  on('state.get', ($, e) => ({ value: e.key === 'run' ? { value: { ...STORED, value: working() }, version: 1 } : { value: undefined, version: 0 } }))
  on('state.set', ($, e) => {
    if (e.key === 'run') written.push((e.value as { value?: Run }).value)
    return { value: { isSet: true, version: 2 } }
  })
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: WINDOW }, cost: { usd: 0 } } as never }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: USAGE }
  })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3, agentId: 'agent-1' })
  for await (const chunk of stream) void chunk
  await stream.result
  expect(written.at(-1)?.workers[0]?.context).toEqual({ used: 33_000, size: WINDOW })
})

test('a subagent records the time of its tool calls and of its model calls by activity, in the write of its next model call', async ($, on) => {
  const written: (Run | undefined)[] = []
  const clock = answerTheEngine(on, undefined)
  on('state.get', ($, e) => ({ value: e.key === 'run' ? { value: { ...STORED, value: working() }, version: 1 } : { value: undefined, version: 0 } }))
  on('state.set', ($, e) => {
    if (e.key === 'run') written.push((e.value as { value?: Run }).value)
    return { value: { isSet: true, version: 2 } }
  })
  on('tool.call', { tool: 'Bash' }, async () => {
    await clock.advance(500)
    return { result: 'ok' }
  })
  on('turn.step', async function* ($, e) {
    await clock.advance(300)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: USAGE }
  })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'Bash', command: 'bun test', agentId: 'agent-1' } as never)
  const stream = $.turn.step({ turnId: 't1', index: 0, model: USAGE.model, messageCount: 3, agentId: 'agent-1' })
  for await (const chunk of stream) void chunk
  await stream.result
  expect(written.at(-1)?.workers[0]?.times).toEqual({ tests: 500, model: 300 })
})

test('the answer of a model call of a subagent becomes the said of its worker', async ($, on) => {
  const written: (Run | undefined)[] = []
  answerTheEngine(on, undefined)
  on('state.get', ($, e) => ({ value: e.key === 'run' ? { value: { ...STORED, value: working() }, version: 1 } : { value: undefined, version: 0 } }))
  on('state.set', ($, e) => {
    if (e.key === 'run') written.push((e.value as { value?: Run }).value)
    return { value: { isSet: true, version: 2 } }
  })
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: 'I claim #2. Then the tests.', toolUses: [], stopReason: 'end_turn' as const, usage: USAGE }
  })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: USAGE.model, messageCount: 3, agentId: 'agent-1' })
  for await (const chunk of stream) void chunk
  await stream.result
  expect(written.at(-1)?.workers[0]?.said).toBe('I claim #2.')
})

test('at the end of a turn, an idle worker with a small context gets the step in its own session, and no new agent', async ($, on) => {
  const engine = $
  const sent: string[] = []
  const spawned: string[] = []
  const written: (Run | undefined)[] = []
  answerTheEngine(on, undefined)
  on('state.get', ($, e) => ({ value: e.key === 'run' ? { value: { ...STORED, value: idleWithSmallContext() }, version: 1 } : { value: undefined, version: 0 } }))
  on('state.set', ($, e) => {
    if (e.key === 'run') written.push((e.value as { value?: Run }).value)
    return { value: { isSet: true, version: 2 } }
  })
  on('agent.list', () => ({ value: [] }))
  on('agent.spawn', ($, e) => {
    spawned.push(e.description)
    return { model: 'claude-opus-5-5', agentId: 'agent-9' }
  })
  on('agent.offer', () => ({ isOffered: true }))
  on('session.send', async (_, e) => {
    const offer = await engine.agent.offer(WORKER_OFFER)
    sent.push(`${e.to}: ${e.text}`)
    return offer.isOffered ? { isDelivered: true as const } : { isDelivered: false as const, reason: 'Agent type meld:worker is not offered in this session.' }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(spawned).toEqual([])
  expect(sent).toEqual(['agent-1: meld: These tasks are open: #1 Add the theme; #2 Add the toggle. Claim one and do it. Read the board with mcp__meld__board, then go on.'])
  expect(written.at(-1)?.workers[0]).toMatchObject({ agentId: 'agent-1', state: 'working', activity: 'goes on' })
})

test('the engine does not offer the meld:worker type to the model, so only meld starts its workers', async ($, on) => {
  answerTheEngine(on, undefined)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  const offered = await $.agent.offer(WORKER_OFFER)
  expect(offered).toEqual({ isOffered: false })
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
  expect(mcp.calls.filter(call => call.tool === 'lead_board').map(call => call.args.board)).toEqual([SESSION, 'old-session'])
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

test('without meld mcp, a start that starts no worker gives no warning about the board file', async ($, on) => {
  let stored: unknown
  answerTheEngine(on, undefined)
  on('state.get', ($, e) => ({ value: e.key === 'run' ? { value: stored, version: 1 } : { value: undefined, version: 0 } }))
  on('state.set', ($, e) => {
    if (e.key === 'run') stored = e.value
    return { value: { isSet: true, version: 2 } }
  })
  on('process.run', ($, e) => gitAnswer(e.argv))
  on('session.usage', () => ({ value: { startedAt: NOW, cost: { usd: 0 } } as never }))
  on('agent.list', () => ({ value: [] }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-9' }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'a test draws no pane' } }))
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  const replied = await $.command.run({ command: 'meld', args: '--agents 2 --vcs git Add a greeting', ...TYPED })
  expect(replied.text).toContain('No worker started')
  expect(replied.text).not.toContain('This run has no board file')
})

test('the worker type compacts its agent at the context cap', async ($, on) => {
  const registered: { name: string; autoCompactWindow?: number }[] = []
  answerTheEngine(on, new FakeMcp(), registered)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  expect(registered).toEqual([{ name: 'worker', autoCompactWindow: CONTEXT_CAP }])
})
