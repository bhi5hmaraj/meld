import type { HttpResponse, McpToolResult } from 'claude-code'

import { ACP_PREFIX, isAcpAgent } from '../core/options'
import type { FactsStore, Runner, Store } from '../core/ports'
import { remoteStore, sameRun } from '../core/remote-store'
import type { Adopted, BoardRead, BoardServer } from '../core/remote-store'
import type { Facts, Run } from '../types'

/**
 * Where this session keeps its run: the board server of meld mcp (empty without it), the board, the owner of its writes,
 * why meld mcp did not connect, and the Unix socket where meld mcp answers board reads (empty without it).
 */
export type SessionBoard = { server: string; id: string; owner: string; problem: string; channel: string }

/** Where the run of the session lives, for the board tool of the main session. */
export type StoreNote = { store: string; board?: string; why?: string; warning?: string }

/** The tools of meld mcp as the session names them: the engine connects it as `plugin:meld:board`. */
export const BOARD_STORE_TOOLS = /^mcp__plugin_meld_board__/

/** The name of this plugin, as the origin of each call that one of its hooks makes. */
const MELD = 'meld'
const ONLY_MELD = 'Only meld calls the board store of meld mcp.'
const RELOAD = 'This session started before meld was installed or updated, so the MCP server of meld did not start. A new session starts it. In a local session, /reload-plugins starts it too.'
const ACP_NEEDS_MCP = 'meld runs ACP agents such as Codex through meld mcp, which did not connect'

type Verdict = { decision: 'allow' | 'deny'; reason: string }

/**
 * The store of a hook: the run on the board of meld mcp, with a copy in the session state that the pane draws from, and
 * the facts in the session state. Without meld mcp, the session state alone, as in meld 0.8.
 */
export function sessionStore(session: SessionBoard, remote: BoardServer, local: Store & FactsStore): Store & FactsStore {
  const facts = { readFacts: () => local.readFacts(), writeFacts: (next: Facts | null) => local.writeFacts(next) }
  if (!session.server) return { read: () => local.read(), write: change => local.write(change), ...facts, store: 'session' }
  const run = remoteStore(remote, copy => local.write(current => (sameRun(current, copy) ? current : copy)))
  return { ...run, ...facts, store: 'file' }
}

/**
 * Brings the copy of the run in the session state up to date from the board channel of meld mcp. A timer runs outside
 * every hook, so it cannot call meld mcp, and ACP workers write to the board through their own meld mcp.
 */
export async function copyFromChannel(session: SessionBoard, fetch: (url: string) => Promise<HttpResponse>, local: Store): Promise<void> {
  if (!session.channel) return
  const answer = await fetch(`http://meld/boards/${encodeURIComponent(session.id)}`)
  if (!answer.ok) return
  const { run } = JSON.parse(answer.text) as BoardRead
  await local.write(current => (sameRun(current, run) ? current : run))
}

/**
 * The runner of a hook: an ACP agent, such as Codex, through the runner of meld mcp; every other agent through the engine.
 * The liveness is that of both, so the plugin settles each worker with what it knows. A resume of an ACP agent needs a
 * runner of meld mcp that can resume; the plugin never resumes one, as only meld mcp starts ACP workers again.
 */
export function sessionRunner(session: SessionBoard, engine: Runner, acp: Runner): Runner {
  const connected = session.server !== ''
  return {
    spawn: async args => {
      if (!args.subagentType.startsWith(ACP_PREFIX)) return engine.spawn(args)
      return connected ? acp.spawn(args) : { deny: `${ACP_NEEDS_MCP}: ${session.problem}` }
    },
    send: async (agentId, text) => {
      if (!isAcpAgent(agentId)) return engine.send(agentId, text)
      if (connected) return acp.send(agentId, text)
    },
    agents: async () => {
      const states = await engine.agents()
      if (!states || !connected) return states
      return new Map([...states, ...((await acp.agents()) ?? [])])
    },
    resume: async (agentId, text) => {
      if (!isAcpAgent(agentId)) return engine.resume ? engine.resume(agentId, text) : false
      return connected && acp.resume ? acp.resume(agentId, text) : false
    },
  }
}

/** The value of a tool of meld mcp: the JSON of its text. A failed call throws its text. */
export function valueOf<T>(result: McpToolResult): T {
  const text = result.content.find(block => block.type === 'text')?.text ?? ''
  if (result.isError) throw new Error(`meld mcp: ${text}`)
  return JSON.parse(text) as T
}

/** What adopt_board answers, as the resume reads it. */
export function adoptedOf(value: { result: string; owner?: string; ownerAt?: number }): Adopted {
  if (value.result === 'adopted' || value.result === 'missing') return value.result
  return { owner: value.owner ?? '', ownerAt: value.ownerAt ?? 0 }
}

/** The names that the model sees for the tools of a board server. */
export function boardToolPrefix(server: string): string {
  return `mcp__${server.replace(/[^a-zA-Z0-9_-]/g, '_')}__`
}

/**
 * The verdict of the permission check on a call of a tool of meld mcp. Each `$.mcp.call` of the plugin goes through the
 * check with meld as its origin, and meld allows it; a call of the model or of another plugin is refused. No verdict
 * for another tool, or when meld mcp did not connect.
 */
export function boardVerdict(tool: string, server: string, origin: string): Verdict | undefined {
  if (!server || !tool.startsWith(boardToolPrefix(server))) return undefined
  return origin === MELD ? { decision: 'allow', reason: 'meld keeps the board of its run in meld mcp.' } : { decision: 'deny', reason: ONLY_MELD }
}

/**
 * The verdict on an offer of the meld:worker type: hidden from the model, as only meld starts its workers. A message of
 * meld resumes a worker that ended its turn, and the engine checks the offer of its type first, with the engine as the
 * origin. So meld offers the type while it resumes one of its workers.
 */
export function workerOffer(isResuming: boolean): { isOffered: false } | undefined {
  return isResuming ? undefined : { isOffered: false }
}

/** Why meld mcp did not connect: the refusal of the engine, with the step that starts meld mcp when the session holds an old manifest. */
export function problemOf(refusal: { reason: string; message: string }): string {
  return refusal.reason === 'unlisted' ? `${refusal.message} ${RELOAD}` : refusal.message
}

/** What a hook gives connectBoard: the connection to meld mcp, and a call of one of its tools. */
export type BoardLink = {
  connect: () => Promise<{ isConnected: true; server: string } | { isConnected: false; reason: string; message: string }>
  call: (tool: string, args: Record<string, unknown>) => Promise<McpToolResult>
}

/**
 * Connects the board of the session to meld mcp. The desktop app can start a session parked, before its MCP servers
 * run, so the hooks that start or drive a run call it again while the session has no server. A run that lives in the
 * session state stays there: only a session with no such run connects.
 */
export async function connectBoard(session: SessionBoard, link: BoardLink, held: Run | null = null): Promise<void> {
  if (session.server || (held && held.state !== 'delivered')) return
  const connected = await link.connect().catch((error: unknown) => ({ isConnected: false as const, reason: 'failed', message: String(error) }))
  session.server = connected.isConnected ? connected.server : ''
  session.problem = connected.isConnected ? '' : problemOf(connected)
  if (!session.server) return
  session.channel = await link.call('board_channel', {}).then(result => valueOf<{ socketPath: string }>(result).socketPath, () => '')
  await link.call('lead_board', { board: session.id, owner: session.owner }).catch(() => undefined)
}

/**
 * What a start tells the person when its new run has no board file: the run lives in the session state, so it ends
 * with the session. A start with no started worker, a run that was there before, and a run on the board of meld mcp
 * get no warning.
 */
export function noBoardWarning(session: SessionBoard, before: Run | null, after: Run | null): string {
  if (session.server || !after || after.id === before?.id || !after.workers.some(worker => worker.agentId)) return ''
  return `This run has no board file: it lives in the session state, it ends with the session, and /meld-resume cannot take it. meld mcp did not connect: ${session.problem}`
}

export function storeNote(session: SessionBoard): StoreNote {
  if (session.server) return { store: 'meld mcp, ~/.meld/meld.db', board: session.id }
  return { store: 'the session state', why: `meld mcp did not connect: ${session.problem}` }
}

/** The reply of the board tool of the main session, with the note of the store next to its fields. */
export function withNote(replied: { result: string }, note: StoreNote): { result: string } {
  const value = JSON.parse(replied.result) as Record<string, unknown>
  return { result: JSON.stringify({ ...value, ...note }) }
}
