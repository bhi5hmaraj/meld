export type WorkerId = 'w1' | 'w2'
export type Author = WorkerId | 'you'
export type RunState = 'starting' | 'working' | 'ready' | 'delivered' | 'stopped'
export type WorkerState = 'starting' | 'working' | 'idle' | 'stopped'
export type TaskState = 'open' | 'claimed' | 'done'
export type EntryKind = 'task' | 'note' | 'check' | 'steer' | 'event'
export type ErrorCode =
  | 'NOT_FOUND'
  | 'STALE_VERSION'
  | 'TAKEN'
  | 'NOT_OWNER'
  | 'INTEGRATION_TAKEN'
  | 'NOT_INTEGRATOR'
  | 'RUN_ENDED'
  | 'STALE_TASK_LIST'

export type Worker = {
  id: WorkerId
  agentId?: string
  path: string
  branch: string
  state: WorkerState
  seenRevision: number
  seenEntry: number
  activity: string
  activityAt: number
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

export type Final = { commit: string; summary: string; by: WorkerId }

export type Run = {
  id: string
  request: string
  revision: number
  state: RunState
  repo: string
  base: string
  startedAt: number
  endedAt?: number
  workers: Worker[]
  tasks: Task[]
  log: Entry[]
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
  you: { id: WorkerId; path: string; branch: string }
  peer: { id: WorkerId; state: WorkerState; branch: string; activity: string }
  request: string
  steers: string[]
  revision: number
  state: RunState
  notice?: Notice
  taskList: number
  tasks: Task[]
  news: Entry[]
  integrator?: WorkerId
  final?: Final
}

declare module 'claude-code' {
  interface PluginState {
    meld: { run: Shaped<Run | null> }
  }
}
