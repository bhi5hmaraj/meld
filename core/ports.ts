import type { Facts, Run } from '../types'

/**
 * The ports of the meld core. A host gives each port: the Claude Code plugin gives them from `$`, a test gives fakes, and
 * `meld mcp` will give them from SQLite, git and ACP. A function of the core takes only the ports that it uses.
 */

export type ProcessResult = { exitCode: number | null; stdout: string; stderr: string }

export type SpawnArgs = { prompt: string; description: string; subagentType: string; model?: string; cwd: string }

export type Spawned = { agentId?: string; deny?: string }

export type AgentState = 'live' | 'ended'

/** One entry of a folder as the host lists it: its name, its kind, and for a file when it last changed (ms since the epoch). */
export type FolderEntry = { name: string; kind: 'file' | 'dir' | 'other'; mtimeMs: number }

/**
 * Where the board of a session keeps its run. A write gives `change` the stored run and stores what it returns, as one
 * step: two writes at once never lose one. A host can run `change` more than once, as a store that compares versions
 * does after a lost race; the run that its last call returned is the one stored.
 */
export type Store = {
  read(): Promise<Run | null>
  write(change: (run: Run | null) => Run | null): Promise<unknown>
}

/**
 * Where a session keeps what its pane shows of the run beside the board: the commits of each worker and the change of
 * the final commit. The session reads them from the version control again, so no other session needs them.
 */
export type FactsStore = {
  readFacts(): Promise<Facts | null>
  writeFacts(facts: Facts | null): Promise<unknown>
}

/** The machine that holds the code: commands such as git and jj, and the files that meld writes. */
export type CodeHost = {
  run(argv: string[], cwd: string): Promise<ProcessResult>
  writeFile(path: string, text: string): Promise<void>
}

/**
 * What /meld-clean reads of the machine beside the CodeHost: the entries of a folder, and the text of a file. Each call
 * rejects when the path is missing. Only the hook of the commands gives it.
 */
export type Files = {
  list(path: string): Promise<FolderEntry[]>
  readText(path: string): Promise<string>
}

/** What starts the agents of a run, sends them text, and lists them. */
export type Runner = {
  spawn(args: SpawnArgs): Promise<Spawned>
  send(agentId: string, text: string): Promise<unknown>
  /** The agents that the host lists, by id; undefined when it cannot list them. */
  agents(): Promise<Map<string, AgentState> | undefined>
  /** Gives an agent that ended its turn a new prompt in its own session. False when the host cannot reach the agent. A host that cannot do it has no resume. */
  resume?(agentId: string, text: string): Promise<boolean>
}

/** Random bytes, for ids that must not collide: two runs that start in one millisecond, on one machine or on two. */
export type Entropy = { random(count: number): Uint8Array }

export type Clock = {
  now(): Promise<number>
  sleep(ms: number): Promise<void>
}

/** Where the person sees meld: toasts, the pane, and the commands of the host. */
export type Surface = {
  toast(text: string): unknown
  openPane(focus: boolean): Promise<unknown>
  command(name: string, args: string): Promise<{ text?: string }>
}

export type Ledger = {
  /** The dollars the session has spent, where the host keeps a cost ledger. */
  cost(): Promise<number | undefined>
}

/** Every port. A hooks module spells `$` only at its call sites, so each hook builds an Io of closures over its own `$`. */
export type Io = Store & FactsStore & CodeHost & Runner & Clock & Entropy & Surface & Ledger

/** A tool that the host offers to the model: its name, what it does, and the JSON schema of its input. */
export type ToolSpec = { name: string; description: string; inputSchema?: Record<string, unknown> }

/** A call of a tool as the core reads it: the tool, the agent that calls it (none for the main session), and its input. */
export type ToolCall = { readonly tool: string; readonly agentId?: string }

/** What a tool answers the model: the JSON of its value. */
export type ToolReply = { result: string }

/** What a command shows: a line of the transcript. */
export type CommandReply = { text?: string }

/** The tokens of one model call. */
export type TokenUsage = { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens?: number }
