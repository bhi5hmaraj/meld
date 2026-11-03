import type {
  AgentSpec,
  Author,
  BoardView,
  Change,
  Entry,
  ErrorCode,
  Failure,
  Final,
  NewTask,
  Notice,
  Run,
  Task,
  VcsKind,
  Worker,
  WorkerId,
  WorkerState,
} from '../types'

const LOG_LIMIT = 500
const ACTIVE = new Set(['starting', 'working'])
const STEERABLE = new Set(['starting', 'working', 'ready'])

export type StartInput = {
  id: string
  request: string
  repo: string
  base: string
  vcs: VcsKind
  now: number
  workers: { id: WorkerId; path: string; ref: string; agent: AgentSpec }[]
}

export type CheckInput = { command: string; commit: string; passed: boolean; output: string }

export function startRun(input: StartInput): Run {
  return {
    id: input.id,
    request: input.request,
    revision: 1,
    state: 'starting',
    vcs: input.vcs,
    repo: input.repo,
    base: input.base,
    startedAt: input.now,
    workers: input.workers.map(worker => ({
      id: worker.id,
      agent: worker.agent,
      path: worker.path,
      ref: worker.ref,
      state: 'starting',
      briefed: false,
      seenRevision: 1,
      seenEntry: 0,
      activity: 'starting',
      activityAt: input.now,
      tokens: 0,
      calls: 0,
    })),
    tasks: [],
    log: [],
    nudges: 0,
    taskList: 0,
  }
}

export function isFailure<T>(change: Change<T>): change is Failure {
  return 'error' in change
}

export function workerOf(run: Run, agentId: string | undefined): Worker | undefined {
  return agentId === undefined ? undefined : run.workers.find(worker => worker.agentId === agentId)
}

export function bindWorker(run: Run, id: WorkerId, agentId: string, now: number): Change<Worker> {
  const ended = endedFailure(run)
  if (ended) return ended
  const worker = findWorker(run, id)
  if (worker.agentId) return failure('TAKEN', `${id} is already bound to another agent.`)
  const bound: Worker = { ...worker, agentId, state: 'working', activity: 'started', activityAt: now }
  return { run: settled(replaceWorker(run, bound)), value: bound }
}

/** A worker whose spawn the engine refused: stopped, with the reason as its last action. */
export function refuseWorker(run: Run, id: WorkerId, reason: string, now: number): Run {
  const worker = findWorker(run, id)
  const refused = replaceWorker(run, { ...worker, state: 'stopped', activity: `not started: ${reason}`, activityAt: now })
  return settled(withEntry(refused, { at: now, by: 'you', kind: 'event', text: `${id} did not start: ${reason}` }))
}

/** A starting run works once every worker is bound or refused, and stops when none started. */
function settled(run: Run): Run {
  if (run.state !== 'starting' || !run.workers.every(worker => worker.agentId || worker.state === 'stopped')) return run
  return run.workers.some(worker => worker.agentId) ? { ...run, state: 'working' } : { ...run, state: 'stopped', endedAt: run.startedAt }
}

export function markBriefed(run: Run, id: WorkerId): Run {
  return replaceWorker(run, { ...findWorker(run, id), briefed: true })
}

export function countCall(run: Run, id: WorkerId): Run {
  const worker = findWorker(run, id)
  return replaceWorker(run, { ...worker, calls: (worker.calls ?? 0) + 1 })
}

export function addTokens(run: Run, id: WorkerId, tokens: number): Run {
  if (!tokens) return run
  const worker = findWorker(run, id)
  return replaceWorker(run, { ...worker, tokens: worker.tokens + tokens })
}

/** Adds a batch of tasks only when the worker has seen the current task list: a stale add fails alone and shows the tasks it missed. */
export function addTasks(
  run: Run,
  by: WorkerId,
  input: { seen: number; tasks: NewTask[] },
  now: number,
): Change<{ tasks: Task[]; taskList: number }> {
  const ended = endedFailure(run)
  if (ended) return ended
  if (input.seen !== run.taskList) {
    return {
      error: 'STALE_TASK_LIST',
      message: `Tasks were added since your read: the task list is at ${run.taskList}, and you saw ${input.seen}. Compare these tasks with yours. Claim the ones that cover your work, and add only what is still missing, with seen ${run.taskList}.`,
      taskList: run.taskList,
      tasks: run.tasks,
    }
  }
  const first = Math.max(0, ...run.tasks.map(task => task.id)) + 1
  const added: Task[] = input.tasks.map((task, index) => ({ id: first + index, title: task.title, detail: task.detail ?? '', state: 'open', version: 1 }))
  const taskList = run.taskList + 1
  const text = `added ${added.map(task => `#${task.id} ${task.title}`).join('; ')}`
  return { run: withEntry({ ...run, tasks: [...run.tasks, ...added], taskList }, { at: now, by, kind: 'task', text }), value: { tasks: added, taskList } }
}

export function claimTask(run: Run, by: WorkerId, id: number, version: number, now: number): Change<Task> {
  const checked = checkTask(run, id, version)
  if (isTaskFailure(checked)) return checked
  if (checked.state !== 'open') return failure('TAKEN', `#${id} is ${describeTask(checked)}.`)
  return updateTask(run, { ...checked, state: 'claimed', owner: by, version: checked.version + 1 }, by, now, `claimed #${id}`)
}

export function releaseTask(run: Run, by: WorkerId, id: number, version: number, note: string, now: number): Change<Task> {
  const checked = checkOwnedTask(run, by, id, version)
  if (isTaskFailure(checked)) return checked
  const released: Task = { ...checked, state: 'open', owner: undefined, version: checked.version + 1 }
  return updateTask(run, released, by, now, `released #${id}${note ? `: ${note}` : ''}`)
}

export function finishTask(
  run: Run,
  by: WorkerId,
  id: number,
  version: number,
  commit: string,
  summary: string,
  now: number,
): Change<Task> {
  const checked = checkOwnedTask(run, by, id, version)
  if (isTaskFailure(checked)) return checked
  const done: Task = { ...checked, state: 'done', commit, summary, version: checked.version + 1 }
  return updateTask(run, done, by, now, `finished #${id}: ${summary}`, commit)
}

export function addNote(run: Run, by: WorkerId, text: string, commit: string | undefined, now: number): Change<Entry> {
  const ended = endedFailure(run)
  if (ended) return ended
  const next = withEntry(run, { at: now, by, kind: 'note', text, commit })
  return { run: next, value: lastEntry(next) }
}

export function addCheck(run: Run, by: WorkerId, check: CheckInput, now: number): Change<Entry> {
  const ended = endedFailure(run)
  if (ended) return ended
  const entry = { at: now, by, kind: 'check' as const, text: check.command, detail: check.output.slice(-800), commit: check.commit, passed: check.passed }
  const next = withEntry(run, entry)
  return { run: next, value: lastEntry(next) }
}

export function takeIntegration(run: Run, by: WorkerId, now: number): Change<WorkerId> {
  const ended = endedFailure(run)
  if (ended) return ended
  if (run.integrator && run.integrator !== by) {
    return failure('INTEGRATION_TAKEN', `${run.integrator} integrates. Do other useful work, or end your turn.`)
  }
  return { run: withEntry({ ...run, integrator: by }, { at: now, by, kind: 'event', text: `${by} integrates` }), value: by }
}

export function declareFinal(run: Run, by: WorkerId, commit: string, summary: string, now: number): Change<Final> {
  const ended = endedFailure(run)
  if (ended) return ended
  if (run.integrator !== by) {
    return failure('NOT_INTEGRATOR', run.integrator ? `${run.integrator} integrates, not you.` : 'Take the integration first.')
  }
  const final: Final = { commit, summary, by }
  const ready = withEntry({ ...run, final, state: 'ready' }, { at: now, by, kind: 'event', text: `final commit: ${summary}`, commit })
  return { run: ready, value: final }
}

export function steer(run: Run, text: string, now: number): Change<number> {
  if (!STEERABLE.has(run.state)) return failure('RUN_ENDED', `The run is ${run.state}.`)
  const revision = run.revision + 1
  const reopened: Run = { ...run, revision, state: run.state === 'ready' ? 'working' : run.state, final: undefined, nudges: 0 }
  return { run: withEntry(reopened, { at: now, by: 'you', kind: 'steer', text, revision }), value: revision }
}

export function takeNotice(run: Run, by: WorkerId): { run: Run; notice?: Notice } {
  const you = findWorker(run, by)
  const steers = unseenSteers(run, you)
  if (!steers.length) return { run }
  return { run: replaceWorker(run, { ...you, seenRevision: run.revision }), notice: { revision: run.revision, steers } }
}

export function steersOf(run: Run): string[] {
  return run.log.filter(entry => entry.kind === 'steer').map(entry => entry.text)
}

export function boardFor(run: Run, by: WorkerId): { run: Run; view: BoardView } {
  const you = findWorker(run, by)
  const steers = unseenSteers(run, you)
  const news = run.log.filter(entry => entry.id > you.seenEntry && entry.by !== by && entry.by !== 'you')
  const view: BoardView = {
    you: { id: you.id, path: you.path, ref: you.ref },
    peers: run.workers
      .filter(worker => worker.id !== by)
      .map(worker => ({ id: worker.id, state: worker.state, ref: worker.ref, activity: worker.activity })),
    vcs: run.vcs,
    request: run.request,
    steers: steersOf(run),
    revision: run.revision,
    state: run.state,
    notice: steers.length ? { revision: run.revision, steers } : undefined,
    taskList: run.taskList,
    tasks: run.tasks,
    news,
    integrator: run.integrator,
    final: run.final,
  }
  const seen: Worker = { ...you, seenRevision: run.revision, seenEntry: run.log.at(-1)?.id ?? 0 }
  return { run: replaceWorker(run, seen), view }
}

export function countNudge(run: Run): Run {
  return { ...run, nudges: run.nudges + 1 }
}

export function setActivity(run: Run, by: WorkerId, activity: string, now: number): Run {
  const worker = findWorker(run, by)
  return replaceWorker(run, { ...worker, activity, activityAt: now })
}

export function setWorkerState(run: Run, by: WorkerId, state: WorkerState, now: number): Run {
  const worker = findWorker(run, by)
  if (worker.state === 'stopped') return run
  return replaceWorker(run, { ...worker, state, activityAt: now })
}

export function stopWorker(run: Run, by: WorkerId, now: number): Run {
  const worker = findWorker(run, by)
  const tasks = run.tasks.map(task =>
    task.state === 'claimed' && task.owner === by ? { ...task, state: 'open' as const, owner: undefined, version: task.version + 1 } : task,
  )
  const integrator = run.integrator === by ? undefined : run.integrator
  const stopped = replaceWorker({ ...run, tasks, integrator }, { ...worker, state: 'stopped', activity: 'stopped', activityAt: now })
  return withEntry(stopped, { at: now, by: 'you', kind: 'event', text: `stopped ${by}` })
}

export function stopRun(run: Run, now: number): Run {
  if (!ACTIVE.has(run.state)) return run
  const workers = run.workers.map(worker => ({ ...worker, state: 'stopped' as const, activity: 'stopped', activityAt: now }))
  return withEntry({ ...run, state: 'stopped', endedAt: now, workers }, { at: now, by: 'you', kind: 'event', text: 'stopped the run' })
}

export function markDelivered(run: Run, now: number): Run {
  return withEntry({ ...run, state: 'delivered', endedAt: now }, { at: now, by: 'you', kind: 'event', text: 'delivered the final commit' })
}

function unseenSteers(run: Run, worker: Worker): string[] {
  return run.log.filter(entry => entry.kind === 'steer' && (entry.revision ?? 0) > worker.seenRevision).map(entry => entry.text)
}

function failure(error: ErrorCode, message: string): Failure {
  return { error, message }
}

function endedFailure(run: Run): Failure | undefined {
  return ACTIVE.has(run.state) ? undefined : failure('RUN_ENDED', `The run is ${run.state}. End your turn.`)
}

function findWorker(run: Run, id: WorkerId): Worker {
  const worker = run.workers.find(one => one.id === id)
  if (!worker) throw new Error(`meld: no worker ${id}`)
  return worker
}

function replaceWorker(run: Run, worker: Worker): Run {
  return { ...run, workers: run.workers.map(one => (one.id === worker.id ? worker : one)) }
}

function withEntry(run: Run, entry: Omit<Entry, 'id'> & { by: Author }): Run {
  const id = (run.log.at(-1)?.id ?? 0) + 1
  return { ...run, log: [...run.log, { ...entry, id }].slice(-LOG_LIMIT) }
}

function lastEntry(run: Run): Entry {
  const entry = run.log.at(-1)
  if (!entry) throw new Error('meld: the log is empty')
  return entry
}

function isTaskFailure(value: Task | Failure): value is Failure {
  return 'error' in value
}

function checkTask(run: Run, id: number, version: number): Task | Failure {
  const ended = endedFailure(run)
  if (ended) return ended
  const task = run.tasks.find(one => one.id === id)
  if (!task) return failure('NOT_FOUND', `There is no task #${id}.`)
  if (task.version !== version) {
    return failure('STALE_VERSION', `#${id} is at version ${task.version} and is ${describeTask(task)}. Read the board, then try again.`)
  }
  return task
}

function checkOwnedTask(run: Run, by: WorkerId, id: number, version: number): Task | Failure {
  const task = checkTask(run, id, version)
  if (isTaskFailure(task)) return task
  if (task.state !== 'claimed' || task.owner !== by) return failure('NOT_OWNER', `#${id} is ${describeTask(task)}, not claimed by you.`)
  return task
}

function updateTask(run: Run, task: Task, by: WorkerId, now: number, text: string, commit?: string): Change<Task> {
  const tasks = run.tasks.map(one => (one.id === task.id ? task : one))
  return { run: withEntry({ ...run, tasks }, { at: now, by, kind: 'task', text, commit }), value: task }
}

function describeTask(task: Task): string {
  if (task.state === 'open') return 'open'
  if (task.state === 'done') return `done by ${task.owner ?? 'a worker'}`
  return `claimed by ${task.owner}`
}
