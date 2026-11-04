import { join } from 'node:path'

import { acpRefusal, markWorker, ownedByAcp, recordActivity, restartIdleWorkers } from '../core/actions'
import { workerOf } from '../core/board'
import { WORKER_SYSTEM } from '../core/contract'
import { ACP_AGENT_PREFIX, ACP_AGENTS, ACP_PREFIX } from '../core/options'
import type { AgentState, Runner, SpawnArgs, Spawned } from '../core/ports'
import { AcpAgent } from './acp'
import type { AcpUpdate, McpServerSpec, PermissionAsk } from './acp'
import { mcpIo } from './io'
import type { SqliteBoards } from './sqlite-store'

/** How often the runner takes the messages that workers of meld mcp left for its ACP agents. */
const POLL_MS = 500
/** How long the first prompt of an agent waits for the bind of its worker on the board. */
const BIND_WAIT_MS = 10_000
const BIND_POLL_MS = 50
const MAIN = join(import.meta.dir, 'main.ts')

export type RunnerOptions = {
  /** The ACP agents by name, with their commands: ACP_AGENTS when absent. */
  commands?: Readonly<Record<string, readonly string[]>>
  onUpdate?: (agentId: string, update: AcpUpdate) => void
  pollMs?: number
}

type Held = { agent: AcpAgent; board: string; started: boolean; queue: string[] }
/** A board whose restarts run now, and whether another prompt ended in the meantime. */
type Restarting = { again: boolean }

/**
 * The ACP runner of the leader. It starts an ACP agent for each worker that the plugin or a restart asks for, each with
 * its own `meld mcp --worker` as its MCP server, and drives its prompts. At the end of a prompt the worker is idle, and
 * meld starts the idle ACP workers again with their next step, as the plugin does for subagents.
 */
export class AcpRunner {
  private readonly held = new Map<string, Held>()
  private readonly restarting = new Map<string, Restarting>()
  private readonly poll: ReturnType<typeof setInterval>
  private closed = false

  constructor(
    private readonly boards: SqliteBoards,
    private readonly options: RunnerOptions = {},
  ) {
    this.poll = setInterval(() => void this.deliverMessages(), options.pollMs ?? POLL_MS)
  }

  /** Starts an agent for a worker of the board. Its first prompt waits for the bind of the worker to the returned agent id. */
  async spawn(board: string, args: SpawnArgs): Promise<Spawned> {
    const command = (this.options.commands ?? ACP_AGENTS)[args.subagentType.slice(ACP_PREFIX.length)]
    if (!args.subagentType.startsWith(ACP_PREFIX) || !command) return { deny: `meld knows no ACP agent ${args.subagentType}` }
    const agentId = `${ACP_AGENT_PREFIX}${hex(crypto.getRandomValues(new Uint8Array(6)))}`
    try {
      const agent = await AcpAgent.start({
        command: [...command],
        cwd: args.cwd,
        mcpServers: [this.workerServer(board, agentId)],
        onUpdate: update => this.updated(board, agentId, update),
        decide: ask => this.decided(board, agentId, ask),
      })
      if (this.closed) {
        await agent.stop()
        return { deny: 'meld mcp is closing' }
      }
      this.held.set(agentId, { agent, board, started: false, queue: [] })
      void this.firstPrompt(board, agentId, `${WORKER_SYSTEM}\n\n${args.prompt}`)
      return { agentId }
    } catch (error) {
      return { deny: error instanceof Error ? error.message : String(error) }
    }
  }

  /** A message to an agent: a new prompt in its session, or the next prompt when it is busy or still starting. */
  async send(agentId: string, text: string): Promise<void> {
    const held = this.held.get(agentId)
    if (!held) return
    if (!held.started || held.agent.state === 'busy') held.queue.push(text)
    else if (held.agent.state === 'idle') void this.run(agentId, text)
  }

  async stop(agentId: string): Promise<void> {
    const held = this.held.get(agentId)
    if (!held) return
    this.held.delete(agentId)
    held.agent.cancel()
    await held.agent.stop()
  }

  async stopAll(): Promise<void> {
    this.closed = true
    clearInterval(this.poll)
    for (const agentId of [...this.held.keys()]) await this.stop(agentId)
  }

  /** The liveness of each agent: live while it starts or runs a prompt, ended when its turn is over. */
  states(): Map<string, AgentState> {
    return new Map([...this.held].map(([agentId, held]) => [agentId, !held.started || held.agent.state === 'busy' ? 'live' : 'ended']))
  }

  /** The Runner port of one board, for the core. */
  runnerFor(board: string): Runner {
    return {
      spawn: args => this.spawn(board, args),
      send: (agentId, text) => this.send(agentId, text),
      agents: async () => this.states(),
    }
  }

  private workerServer(board: string, agentId: string): McpServerSpec {
    return { name: 'meld', command: process.execPath, args: [MAIN, '--worker'], env: { MELD_DB: this.boards.path, MELD_BOARD: board, MELD_AGENT: agentId } }
  }

  private async firstPrompt(board: string, agentId: string, text: string): Promise<void> {
    if (await this.isBound(board, agentId)) await this.run(agentId, text)
    else await this.stop(agentId)
  }

  private async isBound(board: string, agentId: string): Promise<boolean> {
    for (let waited = 0; waited < BIND_WAIT_MS; waited += BIND_POLL_MS) {
      const run = this.boards.read(board).run
      if (run && workerOf(run, agentId)) return true
      await Bun.sleep(BIND_POLL_MS)
    }
    return false
  }

  private async run(agentId: string, text: string): Promise<void> {
    const held = this.held.get(agentId)
    if (!held) return
    held.started = true
    const io = mcpIo(this.boards, held.board, this.runnerFor(held.board))
    await markWorker(io, agentId, 'working')
    await held.agent.prompt(text).catch(() => undefined)
    await this.ended(agentId)
  }

  /** The prompt of an agent ended: its next message runs, or its worker is idle and meld starts the idle ACP workers again. */
  private async ended(agentId: string): Promise<void> {
    const held = this.held.get(agentId)
    if (!held) return
    const next = held.queue.shift()
    if (next !== undefined && held.agent.state === 'idle') return this.run(agentId, next)
    await markWorker(mcpIo(this.boards, held.board, this.runnerFor(held.board)), agentId, 'idle')
    await this.restartIdle(held.board)
    const run = this.boards.read(held.board).run
    if (held.agent.state === 'ended' || !run || !workerOf(run, agentId)) await this.stop(agentId)
  }

  /** Starts the idle ACP workers of the board again, one round at a time: a prompt that ends during a round gets one more round. */
  private async restartIdle(board: string): Promise<void> {
    const running = this.restarting.get(board)
    if (running) {
      running.again = true
      return
    }
    const round: Restarting = { again: true }
    this.restarting.set(board, round)
    try {
      while (round.again && !this.closed) {
        round.again = false
        await restartIdleWorkers(mcpIo(this.boards, board, this.runnerFor(board)), ownedByAcp)
      }
    } finally {
      this.restarting.delete(board)
    }
  }

  private updated(board: string, agentId: string, update: AcpUpdate): void {
    this.options.onUpdate?.(agentId, update)
    if (update.kind === 'tool_call') void recordActivity(mcpIo(this.boards, board, this.runnerFor(board)), agentId, update.text)
  }

  /** The verdict of meld on what an agent asks; a refusal for a stopped worker or a run that ended also ends the prompt. */
  private async decided(board: string, agentId: string, ask: PermissionAsk): Promise<'allow' | 'reject'> {
    const refusal = await acpRefusal(mcpIo(this.boards, board), agentId, ask)
    if (!refusal) return 'allow'
    const run = this.boards.read(board).run
    const worker = run ? workerOf(run, agentId) : undefined
    if (!run || run.state !== 'working' || !worker || worker.state === 'stopped') this.held.get(agentId)?.agent.cancel()
    return 'reject'
  }

  private async deliverMessages(): Promise<void> {
    for (const board of new Set([...this.held.values()].map(held => held.board))) {
      for (const action of this.boards.takeActions(board, 'acp')) await this.send(action.agent, action.text)
    }
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
