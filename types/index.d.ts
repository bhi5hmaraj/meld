export type WorkerId = `w${number}`
export type Author = WorkerId | 'you'
export type VcsKind = 'git' | 'jj'
export type VcsChoice = VcsKind | 'auto'
export type RunState = 'starting' | 'working' | 'ready' | 'delivered' | 'stopped'
export type WorkerState = 'starting' | 'working' | 'idle' | 'stopped'
export type TaskState = 'open' | 'claimed' | 'done'
/** The size of a task: S, M or L, with weights 1, 3 and 8. */
export type TaskSize = 'S' | 'M' | 'L'
/**
 * The kinds of a log entry. The records of the metrics (by `you`): `worker` (a start or a new state of a worker),
 * `merge` (one merge, at its end), `delivered` (a reply carried a context entry to a worker) and `host` (the machine slept).
 */
export type EntryKind = 'task' | 'note' | 'check' | 'steer' | 'event' | 'share' | 'worker' | 'merge' | 'delivered' | 'host'
/** The state of a worker as its lane records it. A waiting worker has a reason. */
export type LaneState = 'working' | 'idle' | 'waiting' | 'stopped'
/** Why a worker waits: for a restart or an approval of meld, a merge, or its own background work. */
export type WaitReason = 'restart' | 'approval' | 'merge' | 'background'
/** Why an agent of a worker started: the start of the run, a new agent, the old agent in its session, a worker that joined. */
export type StartReason = 'start' | 'restart' | 'resume' | 'join'
/** Where the time of a worker goes: model calls, then its tool calls by class (see core/metrics.ts). */
export type Activity = 'model' | 'tests' | 'builds' | 'app' | 'background' | 'tools' | 'board'
/** Sums of milliseconds by activity. */
export type ActivityTimes = Partial<Record<Activity, number>>
/** Sums of tokens by kind. */
export type TokenSums = { input: number; cacheWrite: number; cacheRead: number; output: number }
export type ContextKind = 'fact' | 'fail' | 'interface'
export type ErrorCode =
  | 'NOT_FOUND'
  | 'STALE_VERSION'
  | 'TAKEN'
  | 'NOT_OWNER'
  | 'INTEGRATION_TAKEN'
  | 'NOT_INTEGRATOR'
  | 'RUN_ENDED'
  | 'STALE_TASK_LIST'
  | 'CONFLICT'
  | 'INVALID'
  | 'WAITING'
  /** The final commit lacks the commit of a done task. */
  | 'MISSING_WORK'
  /** A steer of a ready run whose integration line meld has not moved to its final commit. */
  | 'LINE_NOT_MOVED'
  /** A new agent for a worker that the person stopped. */
  | 'WORKER_STOPPED'

/** What runs one worker: an agent type (`meld:worker`, `general-purpose`, a plugin's agent) and an optional model. */
export type AgentSpec = { type: string; model?: string }

export type Worker = {
  id: WorkerId
  agent: AgentSpec
  agentId?: string
  path: string
  ref: string
  state: WorkerState
  briefed: boolean
  seenRevision: number
  seenEntry: number
  activity: string
  activityAt: number
  tokens: number
  /** Tool calls so far; absent in a run that meld 0.2.0 stored. */
  calls?: number
  /**
   * The newest context entry when a reply last carried the context to the agent of this worker. Absent until the first
   * reply to each new agent, and in a run that meld 0.7.0 or older stored: that reply carries the current entries.
   */
  seenContext?: number
  /** The context window of the agent of this worker at its last report. Absent for a new agent, and for an agent that reports none. */
  context?: AgentContext
  /** When meld last gave the agent of this worker a new prompt in its own session. Absent for a new agent. */
  resumedAt?: number
  /** The last sentence of the agent, at most 20 words, and when it said it. Absent until the agent writes text. */
  said?: string
  saidAt?: number
  /** The time of the worker by activity, since the start of the run. */
  times?: ActivityTimes
  /** The tokens of the worker by kind. Absent for an agent that reports no usage. */
  usage?: TokenSums
  /** The largest context of an agent of this worker. */
  largestContext?: number
  /** The fresh agents that meld started for this worker at CONTEXT_CAP. */
  capStarts?: number
}

/** The tokens in the context of an agent, and the size of the window of its model. */
export type AgentContext = { used: number; size: number }

/**
 * A task of the board. A task that other tasks name as their parent is a parent: it is open until all its children are
 * done, and no worker claims it. The fields after summary are absent in a run that meld 0.6.0 stored.
 */
export type Task = {
  id: number
  title: string
  detail: string
  state: TaskState
  owner?: WorkerId
  version: number
  commit?: string
  summary?: string
  /** What the finish left for the tasks that need this task; absent when it left nothing, and in a run that meld 0.7.0 stored. */
  handover?: Handover
  /** The task that this task is a part of; absent for a top-level task. */
  parent?: number
  /** M when absent. */
  size?: TaskSize
  /** The tasks whose results this task needs: it is ready when they are done, and the needs of its ancestors too. */
  needs?: number[]
  addedAt?: number
  /** When its last need was done, or addedAt; absent while it waits. */
  readyAt?: number
  /** When its current owner claimed it; absent while it is open. */
  claimedAt?: number
  doneAt?: number
  /** How many times it went back to open: a release, or the stop of its owner. */
  releases?: number
  /** The tool calls of its owner since the claim. */
  calls?: number
  /** meld told its owner to split it or finish it. */
  nudged?: boolean
  /** The task whose commit this task brings into the integration line: meld adds "integrate #N" when that merge conflicts. */
  integrates?: number
  /** The context entries that its finish names as a help. */
  used?: number[]
  /** The time of its owners on it, by activity. */
  times?: ActivityTimes
  /** The tokens of its owners on it, by kind. */
  usage?: TokenSums
  /** At its finish: the commits of its lane whose author is another worker. */
  taken?: number
}

/** What a finished task leaves for the tasks that need it: the contracts it made, and the work it did not do. */
export type Handover = { interfaces?: string; unfinished?: string }

/** The handover of one done task that a task needs, as a claim reply and a board read give it to a new agent. */
export type HandoverView = Handover & { task: number; title: string; commit?: string }

export type Entry = {
  id: number
  at: number
  by: Author
  kind: EntryKind
  text: string
  detail?: string
  revision?: number
  commit?: string
  passed?: boolean
  /** The task of a task entry (claim, release, finish, split), or of a merge. */
  task?: number
  /** The worker of a record: a `worker`, `merge` or `delivered` entry. */
  worker?: WorkerId
  /** A `worker` entry: the new state, and the reason of a wait. */
  state?: LaneState
  reason?: WaitReason
  /** A `worker` entry for a start of an agent: why it started, and whether a task was ready for it. */
  start?: StartReason
  noTask?: boolean
  /** A `merge` or `host` entry: when the merge or the sleep began. The entry is at its end. */
  from?: number
  /** A `merge` entry: the files of the merge. */
  files?: string[]
  /** A `delivered` entry: the id of the context entry. */
  context?: number
}

/**
 * One entry of the shared context that every worker sees: a fact (a finding with its evidence), a fail (an approach
 * that did not work, with the reason) or an interface (a contract between tasks: a name and its shape).
 */
export type ContextEntry = {
  id: number
  at: number
  kind: ContextKind
  by: WorkerId
  text: string
  commit?: string
  files: string[]
  /** The older entry that this entry corrects: that entry is not current. */
  replaces?: number
  /** The workers, other than the author, whose board replies carried this entry. */
  seenBy: WorkerId[]
}

/** An entry as a board reply shows it. */
export type ContextView = Omit<ContextEntry, 'at'>

export type Final = { commit: string; summary: string; by: WorkerId }

/** The integration line: meld merges the commit of each finished task into it, with no agent. Its head, and the tasks it holds. */
export type Line = { head: string; tasks: number[] }

export type Run = {
  id: string
  request: string
  revision: number
  state: RunState
  vcs: VcsKind
  repo: string
  base: string
  startedAt: number
  endedAt?: number
  /** The dollars the session had spent when the run started; the pane shows what it spent since. */
  costAtStart?: number
  workers: Worker[]
  tasks: Task[]
  log: Entry[]
  /** The shared context; absent in a run that meld 0.5.3 or older stored. */
  context?: ContextEntry[]
  integrator?: WorkerId
  final?: Final
  /** Absent before the first merge, and in a run that meld 0.7.0 or older stored. */
  line?: Line
  nudges: number
  taskList: number
  /** The newest log entry when the main session last read the status view; absent before its first status read. */
  sessionSeen?: number
  /** Where the run lives: the session state only, or a board file. Absent in a run that meld 0.10.1 or older stored. */
  store?: 'session' | 'file'
}

export type Failure = { error: ErrorCode; message: string; taskList?: number; tasks?: Task[] }
export type NewTask = { title: string; detail?: string; parent?: number; size?: TaskSize; needs?: number[] }
export type Change<T> = { run: Run; value: T } | Failure

export type Notice = { revision: number; steers: string[] }

export type BoardView = {
  you: { id: WorkerId; path: string; ref: string }
  peers: { id: WorkerId; state: WorkerState; ref: string; activity: string }[]
  vcs: VcsKind
  rules?: string
  request: string
  steers: string[]
  revision: number
  state: RunState
  notice?: Notice
  taskList: number
  tasks: Task[]
  news: Entry[]
  context: ContextView[]
  integrator?: WorkerId
  final?: Final
  /** The handovers of the done tasks that the claims of the reader need; absent when there are none. */
  handovers?: HandoverView[]
}

/** A commit of one worker since the base, as the version control has it. */
export type CommitFact = { commit: string; subject: string; parents: number; conflict: boolean }

/**
 * What the version control shows of one worker: its commits since the base, newest first, and whether it has edits it has
 * not committed. A lane that the version control could not read has its error, and its commits and edits are unknown.
 */
export type LaneFacts = { id: WorkerId; commits: CommitFact[]; edits: boolean; error?: string }

/** One changed file of the result: its line counts and its unified-diff hunks, cut when long. */
export type FileChange = { path: string; added: number; removed: number; patch: string }

/** The change of the final commit against the base: the first files with their diffs, and the totals of all files. */
export type ResultFacts = { commit: string; files: FileChange[]; fileCount: number; added: number; removed: number }

export type Facts = { run: string; lanes: LaneFacts[]; result?: ResultFacts }

/** What the pane keeps between draws: the open diff, the start form and the open rows of the progress. */
export type PaneView = {
  showDiff: boolean
  task: string
  agents: number
  model: string
  vcs: VcsChoice
  /** The tasks whose children the progress shows; absent in a view that meld 0.6.0 stored. */
  open?: number[]
}

declare module 'claude-code' {
  interface PluginState {
    meld: {
      run: Shaped<Run | null>
      facts: Shaped<Facts | null>
      view: Shaped<PaneView | null>
      /** The board of meld mcp that this session works on: absent until a resume takes the board of another session. */
      board: Shaped<string | null>
    }
  }
}
