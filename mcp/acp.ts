import type { Subprocess } from 'bun'

import type { AgentContext } from '../types'
import { Peer, readLines } from './json-rpc'

/** The Agent Client Protocol: meld is the client of an agent process such as `codex-acp`, over standard input and output. */

/** The version of ACP that meld speaks. */
const PROTOCOL_VERSION = 1
/** How much of the end of the error output of an agent goes into the reason of its exit. */
const ERROR_TAIL = 400

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'

/** One update of a session, as meld reads it: its kind (`agent_message_chunk`, `tool_call`, ...), a text, and for a tool call its id and status. */
/** An update of the session; a usage update gives the tokens in the context of the agent and the size of its window. */
export type AcpUpdate = { kind: string; text: string; status?: string; toolCallId?: string; usage?: AgentContext }

/** What an agent asks to do: the title and kind of the tool call, and the paths that it touches. */
export type PermissionAsk = { title: string; kind: string; paths: string[] }

/** An MCP server that the agent starts for its session, such as the `meld mcp` of the worker. `command` is an absolute path. */
export type McpServerSpec = { name: string; command: string; args: string[]; env: Record<string, string> }

export type AcpOptions = {
  /** The command and arguments of the agent, such as `npx -y @agentclientprotocol/codex-acp`. */
  command: string[]
  /** The folder of the session: the workspace of the worker. */
  cwd: string
  env?: Record<string, string>
  mcpServers: McpServerSpec[]
  onUpdate(update: AcpUpdate): void
  decide(ask: PermissionAsk): Verdict | Promise<Verdict>
}

type PermissionOption = { optionId: string; kind: string }
type Verdict = 'allow' | 'reject'

/** An ACP agent process with one session. meld runs one prompt at a time, and a new prompt continues the session. */
export class AcpAgent {
  readonly exited: Promise<number | null>
  private sessionIdOf = ''
  private busy = false
  private ended = false
  private errorTail = ''

  private constructor(
    private readonly child: Subprocess<'pipe', 'pipe', 'pipe'>,
    private readonly peer: Peer,
  ) {
    this.exited = child.exited.then(code => {
      this.ended = true
      const tail = this.errorTail.trim().split('\n').at(-1)
      this.peer.close(`the ACP agent exited with code ${code}${tail ? `: ${tail}` : ''}`)
      return code
    })
  }

  /** Starts the agent in the folder, and opens its session. */
  static async start(options: AcpOptions): Promise<AcpAgent> {
    const child = Bun.spawn(options.command, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    const peer = new Peer(line => writeLine(child, line), {
      request: async (method, params) => {
        if (method === 'session/request_permission') return outcomeOf(params, await options.decide(askOf(params)))
        throw new Error(`meld gives no ${method}`)
      },
      notify: (method, params) => {
        if (method === 'session/update' && isRecord(params.update)) options.onUpdate(updateOf(params.update))
      },
    })
    const agent = new AcpAgent(child, peer)
    void readLines(child.stdout, line => peer.receive(line))
    void readLines(child.stderr, line => agent.keepError(line))
    try {
      await peer.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'meld', version: '0.10' } })
      const session = (await peer.request('session/new', { cwd: options.cwd, mcpServers: options.mcpServers.map(acpServer) })) as { sessionId: string }
      agent.sessionIdOf = session.sessionId
      return agent
    } catch (error) {
      await agent.stop()
      throw error
    }
  }

  get sessionId(): string {
    return this.sessionIdOf
  }

  get state(): 'idle' | 'busy' | 'ended' {
    return this.ended ? 'ended' : this.busy ? 'busy' : 'idle'
  }

  /** Sends a prompt to the session, and resolves with the stop reason when the agent ends its turn. */
  async prompt(text: string): Promise<StopReason> {
    if (this.ended) throw new Error('the ACP agent ended')
    if (this.busy) throw new Error('the ACP agent runs a prompt: meld sends one prompt at a time')
    this.busy = true
    try {
      const reply = (await this.peer.request('session/prompt', { sessionId: this.sessionIdOf, prompt: [{ type: 'text', text }] })) as { stopReason: StopReason }
      return reply.stopReason
    } finally {
      this.busy = false
    }
  }

  /** Asks the agent to end its turn: the prompt then resolves as cancelled. */
  cancel(): void {
    this.peer.notify('session/cancel', { sessionId: this.sessionIdOf })
  }

  /** Ends the process of the agent, and resolves with its exit code. */
  async stop(): Promise<number | null> {
    if (!this.ended) this.child.kill()
    return this.exited
  }

  private keepError(line: string): void {
    this.errorTail = `${this.errorTail}${line}\n`.slice(-ERROR_TAIL)
  }
}

function writeLine(child: Subprocess<'pipe', 'pipe', 'pipe'>, line: string): void {
  child.stdin.write(`${line}\n`)
  void child.stdin.flush()
}

function acpServer(server: McpServerSpec): object {
  return { name: server.name, command: server.command, args: server.args, env: Object.entries(server.env).map(([name, value]) => ({ name, value })) }
}

function askOf(params: Record<string, unknown>): PermissionAsk {
  const call = isRecord(params.toolCall) ? params.toolCall : {}
  const locations = Array.isArray(call.locations) ? call.locations : []
  const paths = locations.flatMap(location => (isRecord(location) && typeof location.path === 'string' ? [location.path] : []))
  return { title: typeof call.title === 'string' ? call.title : '', kind: typeof call.kind === 'string' ? call.kind : 'other', paths }
}

/** The answer to a permission request: the option of the verdict that holds for this call only, else for every call. */
function outcomeOf(params: Record<string, unknown>, verdict: Verdict): object {
  const options = (Array.isArray(params.options) ? params.options : []).filter(isRecord) as PermissionOption[]
  const option = options.find(one => one.kind === `${verdict}_once`) ?? options.find(one => one.kind === `${verdict}_always`)
  return { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } }
}

function updateOf(update: Record<string, unknown>): AcpUpdate {
  const kind = String(update.sessionUpdate)
  const content = isRecord(update.content) ? update.content : undefined
  const entries = Array.isArray(update.entries) ? update.entries.filter(isRecord) : []
  const text =
    content?.type === 'text' && typeof content.text === 'string'
      ? content.text
      : kind === 'plan'
        ? entries.map(entry => String(entry.content)).join('; ')
        : typeof update.title === 'string'
          ? update.title
          : ''
  return {
    kind,
    text,
    ...(typeof update.status === 'string' && { status: update.status }),
    ...(typeof update.toolCallId === 'string' && { toolCallId: update.toolCallId }),
    ...(typeof update.used === 'number' && typeof update.size === 'number' && update.size > 0 && { usage: { used: update.used, size: update.size } }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
