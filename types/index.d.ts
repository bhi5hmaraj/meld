export type WorkerId = `w${number}`
export type Author = WorkerId | 'you'
export type VcsKind = 'git' | 'jj'
export type VcsChoice = VcsKind | 'auto'
export type RunState = 'starting' | 'working' | 'ready' | 'delivered' | 'stopped'
export type WorkerState = 'starting' | 'working' | 'idle' | 'stopped'
export type TaskState = 'open' | 'claimed' | 'done'
export type EntryKind = 'task' | 'note' | 'check' | 'steer' | 'event' | 'share'
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
}

export type Task = {
  id: number
  title: string
  detail: string
  state: TaskState
  owner?: WorkerId
  version: number
  commit?: string
  summary?: string
}

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
  context: ContextEntry[]
  integrator?: WorkerId
  final?: Final
  nudges: number
  taskList: number
}

export type Failure = { error: ErrorCode; message: string; taskList?: number; tasks?: Task[] }
export type NewTask = { title: string; detail?: string }
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
}

/** A commit of one worker since the base, as the version control has it. */
export type CommitFact = { commit: string; subject: string; parents: number; conflict: boolean }

/** What the version control shows of one worker: its commits since the base, newest first, and whether it has edits it has not committed. */
export type LaneFacts = { id: WorkerId; commits: CommitFact[]; edits: boolean }

/** One changed file of the result: its line counts and its unified-diff hunks, cut when long. */
export type FileChange = { path: string; added: number; removed: number; patch: string }

/** The change of the final commit against the base: the first files with their diffs, and the totals of all files. */
export type ResultFacts = { commit: string; files: FileChange[]; fileCount: number; added: number; removed: number }

export type Facts = { run: string; lanes: LaneFacts[]; result?: ResultFacts }

/** What the pane keeps between draws: the open diff and the start form. */
export type PaneView = {
  showDiff: boolean
  task: string
  agents: number
  model: string
  vcs: VcsChoice
}

declare module 'claude-code' {
  interface PluginState {
    meld: {
      run: Shaped<Run | null>
      facts: Shaped<Facts | null>
      view: Shaped<PaneView | null>
    }
  }
}
