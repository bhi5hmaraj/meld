import { expect, test } from 'claude-code/testing'

import type { AgentState, Runner, SpawnArgs, Spawned } from '../core/ports'
import { boardVerdict, problemOf, sessionRunner, storeNote, withNote, workerOffer } from '../hooks/board-store'

const SERVER = 'plugin:meld:board'
const READ = 'mcp__plugin_meld_board__read_board'
const ONLY_MELD = { decision: 'deny', reason: 'Only meld calls the board store of meld mcp.' }
const UNLISTED = 'This plugin\'s manifest lists no MCP server named "board".'
const SPAWN: SpawnArgs = { prompt: 'Go', description: 'meld w1', subagentType: 'meld:worker', cwd: '/tmp/meld/r1/w1' }

/** A runner that records each spawn and message, and gives a fixed liveness. */
class RecordingRunner implements Runner {
  constructor(
    private readonly name: string,
    private readonly states: Map<string, AgentState>,
    readonly calls: string[],
  ) {}

  async spawn(args: SpawnArgs): Promise<Spawned> {
    this.calls.push(`${this.name} spawn ${args.subagentType}`)
    return { agentId: `${this.name}-1` }
  }

  async send(agentId: string): Promise<void> {
    this.calls.push(`${this.name} send ${agentId}`)
  }

  async agents(): Promise<Map<string, AgentState>> {
    return this.states
  }

  async resume(agentId: string): Promise<boolean> {
    this.calls.push(`${this.name} resume ${agentId}`)
    return true
  }
}

test('the permission check allows a call of meld itself of a tool of meld mcp, as meld keeps its board there', () => {
  expect(boardVerdict(READ, SERVER, 'meld')).toEqual({ decision: 'allow', reason: 'meld keeps the board of its run in meld mcp.' })
})

test('the permission check refuses a call of a tool of meld mcp from the model or from another plugin', () => {
  expect(boardVerdict(READ, SERVER, 'engine')).toEqual(ONLY_MELD)
  expect(boardVerdict(READ, SERVER, 'notes')).toEqual(ONLY_MELD)
})

test('the permission check gives no verdict for another tool, or when meld mcp did not connect', () => {
  expect(boardVerdict('mcp__meld__claim', SERVER, 'engine')).toBeUndefined()
  expect(boardVerdict(READ, '', 'engine')).toBeUndefined()
})

test('the meld:worker type stays hidden from the model, except while meld resumes one of its workers', () => {
  expect(workerOffer(false)).toEqual({ isOffered: false })
  expect(workerOffer(true)).toBeUndefined()
})

test('an unlisted meld mcp names the reload that starts it, and another refusal keeps its message', () => {
  expect(problemOf({ reason: 'unlisted', message: UNLISTED })).toBe(`${UNLISTED} This session loaded meld before its manifest listed meld mcp: /reload-plugins or a new session starts it.`)
  expect(problemOf({ reason: 'failed', message: 'bun: not found' })).toBe('bun: not found')
})

test('the note of the store names the board in meld mcp, or why meld mcp is not there', () => {
  expect(storeNote({ server: SERVER, id: 's1', owner: 's1', problem: '', channel: '' })).toEqual({ store: 'meld mcp, ~/.meld/meld.db', board: 's1' })
  expect(storeNote({ server: '', id: 's1', owner: 's1', problem: 'bun: not found', channel: '' })).toEqual({ store: 'the session state', why: 'meld mcp did not connect: bun: not found' })
})

test('the note goes into the reply of the board tool of the main session, next to its fields', () => {
  const replied = withNote({ result: JSON.stringify({ state: 'none' }) }, { store: 'the session state', why: 'meld mcp did not connect: bun: not found' })
  expect(JSON.parse(replied.result)).toEqual({ state: 'none', store: 'the session state', why: 'meld mcp did not connect: bun: not found' })
})

test('the runner of a hook gives the ACP spawns and messages to meld mcp, the rest to the engine, and the liveness of both', async () => {
  const calls: string[] = []
  const runner = sessionRunner({ server: SERVER, id: 's1', owner: 's1', problem: '', channel: '' }, new RecordingRunner('engine', new Map([['agent-1', 'live']]), calls), new RecordingRunner('acp', new Map([['acp-1', 'ended']]), calls))
  expect(await runner.spawn({ ...SPAWN, subagentType: 'acp:codex' })).toEqual({ agentId: 'acp-1' })
  expect(await runner.spawn(SPAWN)).toEqual({ agentId: 'engine-1' })
  await runner.send('acp-1', 'Go on')
  await runner.send('agent-1', 'Go on')
  expect(calls).toEqual(['acp spawn acp:codex', 'engine spawn meld:worker', 'acp send acp-1', 'engine send agent-1'])
  expect([...((await runner.agents()) ?? [])]).toEqual([
    ['agent-1', 'live'],
    ['acp-1', 'ended'],
  ])
})

test('the runner of a hook gives the resume of a Claude agent to the engine, and of an ACP agent to meld mcp', async () => {
  const calls: string[] = []
  const runner = sessionRunner({ server: SERVER, id: 's1', owner: 's1', problem: '', channel: '' }, new RecordingRunner('engine', new Map(), calls), new RecordingRunner('acp', new Map(), calls))
  expect(await runner.resume?.('agent-1', 'Go on')).toBe(true)
  expect(await runner.resume?.('acp-1', 'Go on')).toBe(true)
  expect(calls).toEqual(['engine resume agent-1', 'acp resume acp-1'])
})

test('without meld mcp, an ACP worker does not start and says why, and the liveness is that of the engine', async () => {
  const calls: string[] = []
  const runner = sessionRunner({ server: '', id: 's1', owner: 's1', problem: 'bun: not found', channel: '' }, new RecordingRunner('engine', new Map([['agent-1', 'live']]), calls), new RecordingRunner('acp', new Map(), calls))
  expect(await runner.spawn({ ...SPAWN, subagentType: 'acp:codex' })).toEqual({ deny: 'meld runs ACP agents such as Codex through meld mcp, which did not connect: bun: not found' })
  await runner.send('acp-1', 'Go on')
  expect(await runner.resume?.('acp-1', 'Go on')).toBe(false)
  expect(calls).toEqual([])
  expect([...((await runner.agents()) ?? [])]).toEqual([['agent-1', 'live']])
})
