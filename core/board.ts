import type {
  ActivityTimes,
  AgentContext,
  AgentSpec,
  Author,
  BoardView,
  Change,
  ContextEntry,
  ContextKind,
  ContextView,
  Entry,
  ErrorCode,
  Failure,
  Final,
  Handover,
  HandoverView,
  LaneState,
  Line,
  NewTask,
  Notice,
  Run,
  StartReason,
  Task,
  TaskSize,
  TokenSums,
  VcsKind,
  Worker,
  WorkerId,
  WorkerState,
} from '../types'
import type { AgentState } from './ports'
import { childrenOf, claimable, isParent, isReady, taskOf, waitsFor, waitsOn } from './tasks'

const LOG_LIMIT = 500
/**
 * A record of the metrics that the status view and the overview of the main session leave out of their log: a delivery of
 * context, or a change of state of a worker that is neither a start nor a stop.
 */
export function isQuiet(entry: Entry): boolean {
  return entry.kind === 'delivered' || (entry.kind === 'worker' && !entry.start && entry.state !== 'stopped')
}
/** The random characters at the end of a run id. */
export const RUN_ID_BYTES = 4
const CONTEXT_KEPT = 200
export const CONTEXT_KINDS: readonly ContextKind[] = ['fact', 'fail', 'interface']
export const CONTEXT_TEXT_LIMIT = 500
export const CONTEXT_SHOWN = 20
const SIZES: readonly TaskSize[] = ['S', 'M', 'L']
/**
 * The tool calls on one leaf, with no finish and no split, after which meld tells its owner to split it or finish it.
 * The limit goes by the size of the leaf, and a leaf with no size is M: one limit for every task nudged the owners of
 * half the tasks of a long run, small and large alike.
 */
export const SPLIT_CALLS: Readonly<Record<TaskSize, number>> = { S: 30, M: 60, L: 120 }
const ACTIVE = new Set(['starting', 'working'])
const STEERABLE = new Set(['starting', 'working', 'ready'])

export type StartInput = {
  id: string
  request: string
  repo: string
  base: string
  vcs: VcsKind
  now: number
  costAtStart?: number
  store?: 'session' | 'file'
  workers: { id: WorkerId; path: string; ref: string; agent: AgentSpec }[]
}

export type CheckInput = { command: string; commit: string; passed: boolean; output: string }

export type ShareInput = { kind: string; text: string; commit?: string; files?: string[]; replaces?: number }

export type { Handover }

/** A split: the task and its version, the version of the task list that the worker saw, and the parts. */
export type SplitInput = { task: number; version: number; seen: number; tasks: NewTask[] }

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
    costAtStart: input.costAtStart,
    store: input.store,
    workers: input.workers.map(worker => newWorker(worker, input.now)),
    tasks: [],
    log: [],
    context: [],
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
  const start = run.state === 'starting' ? 'start' : 'join'
  return { run: settled(withWorkerEntry(replaceWorker(run, bound), id, 'working', now, `${id} starts`, start)), value: bound }
}

/** Marks the last action of a worker that never started, ahead of the engine's reason for the refusal. */
export const NOT_STARTED = 'not started: '

/** A worker whose spawn the engine refused: stopped, with the reason as its last action. */
export function refuseWorker(run: Run, id: WorkerId, reason: string, now: number): Run {
  const worker = findWorker(run, id)
  const refused = replaceWorker(run, { ...worker, state: 'stopped', activity: `${NOT_STARTED}${reason}`, activityAt: now })
  return settled(withWorkerEntry(refused, id, 'stopped', now, `${id} did not start: ${reason}`))
}

/** A starting run works once every worker is bound or refused, and stops when none started. */
function settled(run: Run): Run {
  if (run.state !== 'starting' || !run.workers.every(worker => worker.agentId || worker.state === 'stopped')) return run
  return run.workers.some(worker => worker.agentId) ? { ...run, state: 'working' } : { ...run, state: 'stopped', endedAt: run.startedAt }
}

export function markBriefed(run: Run, id: WorkerId, briefed = true): Run {
  return replaceWorker(run, { ...findWorker(run, id), briefed })
}

/** A tool call of a worker counts for the worker and for each leaf that it claimed. */
export function countCall(run: Run, id: WorkerId): Run {
  const worker = findWorker(run, id)
  const tasks = run.tasks.map(task => (isClaimedBy(task, id) ? { ...task, calls: (task.calls ?? 0) + 1 } : task))
  return replaceWorker({ ...run, tasks }, { ...worker, calls: (worker.calls ?? 0) + 1 })
}

/** The first leaf of the worker with the calls of its size limit or more and no nudge: it gets its nudge, so meld tells its owner one time. */
export function takeSplitNudge(run: Run, by: WorkerId): { run: Run; task?: Task } {
  const task = run.tasks.find(one => isClaimedBy(one, by) && !one.nudged && (one.calls ?? 0) >= SPLIT_CALLS[one.size ?? 'M'])
  if (!task) return { run }
  const nudged: Task = { ...task, nudged: true }
  return { run: { ...run, tasks: run.tasks.map(one => (one.id === task.id ? nudged : one)) }, task: nudged }
}

export function addTokens(run: Run, id: WorkerId, tokens: number): Run {
  if (!tokens) return run
  const worker = findWorker(run, id)
  return replaceWorker(run, { ...worker, tokens: worker.tokens + tokens })
}

/** Adds the time of a worker by activity to the worker and to each task that it holds. */
export function addTimes(run: Run, id: WorkerId, times: ActivityTimes): Run {
  if (!Object.keys(times).length) return run
  const worker = findWorker(run, id)
  const tasks = run.tasks.map(task => (isClaimedBy(task, id) ? { ...task, times: summed(task.times, times) } : task))
  return replaceWorker({ ...run, tasks }, { ...worker, times: summed(worker.times, times) })
}

/** Adds the tokens of one model call by kind to the worker and to each task that it holds, and counts the call. */
export function addUsage(run: Run, id: WorkerId, usage: TokenSums): Run {
  const worker = findWorker(run, id)
  const tasks = run.tasks.map(task => (isClaimedBy(task, id) ? { ...task, usage: summed(task.usage, usage) } : task))
  return replaceWorker({ ...run, tasks }, { ...worker, usage: summed(worker.usage, usage), steps: (worker.steps ?? 0) + 1 })
}

/** The sum of two records by key: times by activity, or tokens by kind. */
function summed<T extends Partial<Record<string, number>>>(sum: T | undefined, more: T): T {
  const total: Partial<Record<string, number>> = { ...sum }
  for (const [key, value] of Object.entries(more)) total[key] = (total[key] ?? 0) + (value ?? 0)
  return total as T
}

/**
 * A new agent takes the place of a worker whose run ended: it works in the same folder, and reads its rules and the current
 * context again. The person can stop the worker or the run while the engine starts the agent: then the agent takes no place.
 */
export function restartWorker(run: Run, id: WorkerId, agentId: string, now: number): Change<Worker> {
  if (run.state !== 'working') return failure('RUN_ENDED', `The run is ${run.state}.`)
  const { seenContext: _seen, context, resumedAt: _resumed, ...worker } = findWorker(run, id)
  if (worker.state === 'stopped') return failure('WORKER_STOPPED', `The person stopped ${id}.`)
  const capStarts = (context?.used ?? 0) >= CONTEXT_CAP ? { capStarts: (worker.capStarts ?? 0) + 1 } : {}
  const restarted: Worker = { ...worker, ...capStarts, agentId, state: 'working', briefed: false, activity: 'started again', activityAt: now }
  return { run: withWorkerEntry(replaceWorker(run, restarted), id, 'working', now, `${id} starts again`, 'restart'), value: restarted }
}

/**
 * The agent of a worker goes on in its own session with a new prompt: the worker works again, and its agent keeps what
 * it read. The agent list can show the turn before the prompt as ended for a moment, so settleEnded waits (resumedAt).
 */
export function resumeWorker(run: Run, id: WorkerId, now: number): Change<Worker> {
  if (run.state !== 'working') return failure('RUN_ENDED', `The run is ${run.state}.`)
  const worker = findWorker(run, id)
  if (worker.state === 'stopped') return failure('WORKER_STOPPED', `The person stopped ${id}.`)
  const resumed: Worker = { ...worker, state: 'working', activity: 'goes on', activityAt: now, resumedAt: now }
  return { run: withWorkerEntry(replaceWorker(run, resumed), id, 'working', now, `${id} goes on in its session`, 'resume'), value: resumed }
}

/** Below this share of its window, the context of an agent leaves room for one more task. */
export const AFFINITY_SHARE = 0.5

/**
 * The most tokens in the context of an agent: a meld worker compacts its conversation there, and an idle worker past it
 * gets a fresh agent. Each model call reads the whole context again, so on a window of 1M tokens a long session makes
 * cache reads most of the cost of a run.
 */
export const CONTEXT_CAP = 150_000

/** The agent of an idle worker goes on in its own session while its context fills less than AFFINITY_SHARE of its window, and less than CONTEXT_CAP. */
export function keepsSession(worker: Worker): boolean {
  return worker.agentId !== undefined && worker.context !== undefined && worker.context.used < Math.min(AFFINITY_SHARE * worker.context.size, CONTEXT_CAP)
}

/** The context of the agent of a worker at its last report, and the largest context of its agents so far. */
export function setContext(run: Run, by: WorkerId, context: AgentContext): Run {
  const worker = findWorker(run, by)
  return replaceWorker(run, { ...worker, context, largestContext: Math.max(worker.largestContext ?? 0, context.used) })
}

/** Adds a batch of tasks only when the worker has seen the current task list: a stale add fails alone and shows the tasks it missed. */
export function addTasks(
  run: Run,
  by: WorkerId,
  input: { seen: number; tasks: NewTask[] },
  now: number,
): Change<{ tasks: Task[]; taskList: number }> {
  const ended = actingFailure(run, by)
  if (ended) return ended
  if (input.seen !== run.taskList) {
    return staleTasks(
      run,
      'STALE_TASK_LIST',
      `Tasks were added since your read: the task list is at ${run.taskList}, and you saw ${input.seen}. Compare these tasks with yours. Claim the ones that cover your work, and add only what is still missing, with seen ${run.taskList}.`,
    )
  }
  const added = newTasks(run.tasks, input.tasks, now)
  if (!Array.isArray(added)) return added
  const taskList = run.taskList + 1
  const text = `added ${added.map(task => `#${task.id} ${task.title}`).join('; ')}`
  return { run: withEntry({ ...run, tasks: [...run.tasks, ...added], taskList }, { at: now, by, kind: 'task', text }), value: { tasks: added, taskList } }
}

/** The new tasks take the next numbers in order, so a new task can name a task of the board or an earlier new task. */
function newTasks(tasks: readonly Task[], inputs: NewTask[], now: number): Task[] | Failure {
  const first = Math.max(0, ...tasks.map(task => task.id)) + 1
  const added: Task[] = []
  for (const [index, input] of inputs.entries()) {
    const known = [...tasks, ...added]
    const refused = newTaskFailure(known, input)
    if (refused) return refused
    added.push(newTask(known, first + index, input, now))
  }
  return added
}

function newTaskFailure(known: readonly Task[], input: NewTask): Failure | undefined {
  const name = `"${input.title}"`
  if (input.size !== undefined && !SIZES.includes(input.size)) return failure('INVALID', `The size of ${name} is S, M or L, not "${input.size}".`)
  const missing = [input.parent, ...(input.needs ?? [])].find(id => id !== undefined && !taskOf(known, id))
  if (missing !== undefined) return failure('NOT_FOUND', `${name} names #${missing}, which is not on the board. Name a task of the board, or an earlier task of the same call.`)
  const parent = taskOf(known, input.parent)
  if (parent?.state === 'done') return failure('INVALID', `#${parent.id} is done. Add ${name} under an open task, or with no parent.`)
  if (parent?.state === 'claimed') return failure('INVALID', `${parent.owner} claims #${parent.id}. Its owner can divide it with split.`)
  const ancestors = ancestorsOf(known, input.parent)
  for (const need of input.needs ?? []) {
    const loop = waitsOn(known, need, ancestors)
    if (loop === need) return failure('INVALID', `${name} cannot need #${need}: ${name} is a part of #${need}, and a parent waits for its parts.`)
    if (loop !== undefined) return failure('INVALID', `${name} cannot need #${need}: #${need} waits for #${loop}, and #${loop} waits for ${name}.`)
  }
  return undefined
}

function newTask(known: readonly Task[], id: number, input: NewTask, now: number): Task {
  const needs = [...new Set(input.needs ?? [])]
  const task: Task = {
    id,
    title: input.title,
    detail: input.detail ?? '',
    state: 'open',
    version: 1,
    ...(input.parent === undefined ? {} : { parent: input.parent }),
    ...(input.size === undefined ? {} : { size: input.size }),
    ...(needs.length ? { needs } : {}),
    addedAt: now,
  }
  return isReady([...known, task], task) ? { ...task, readyAt: now } : task
}

/**
 * Splits a task of the worker into parts in one change, so no peer takes a part between two calls. The task becomes
 * their parent, with no owner. The worker keeps the first part as its claim, and the other parts are open. As with an
 * add, the worker must have seen the current task list: the needs of a part name tasks by number, so a split from a
 * stale read could make a part need the wrong task. It fails with STALE_VERSION and the current tasks.
 */
export function splitTask(run: Run, by: WorkerId, input: SplitInput, now: number): Change<{ tasks: Task[]; taskList: number }> {
  const { task: id, version, seen, tasks: parts } = input
  const checked = checkOwnedTask(run, by, id, version)
  if (isTaskFailure(checked)) return checked
  if (seen !== run.taskList) {
    const saw = Number.isFinite(seen) ? `and you saw ${seen}` : 'and you gave no seen version'
    return staleTasks(
      run,
      'STALE_VERSION',
      `The task list is at ${run.taskList}, ${saw}. Check the needs of your parts against these tasks, then split #${id} again with seen ${run.taskList}.`,
    )
  }
  const parent: Task = { ...checked, state: 'open', owner: undefined, claimedAt: undefined, calls: undefined, nudged: undefined, version: checked.version + 1 }
  const tasks = run.tasks.map(one => (one.id === id ? parent : one))
  const made = newTasks(tasks, parts.map(part => ({ ...part, parent: id })), now)
  if (!Array.isArray(made)) return made
  const [first, ...others] = made
  if (!first || !others.length) return failure('INVALID', `A split makes two parts or more. To do #${id} as one task, finish it.`)
  const need = taskOf(tasks, waitsFor([...tasks, ...made], first))
  if (need) return failure('WAITING', `The first part waits for #${need.id}, which is ${describeTask(need)}. You keep the first part, so it must be ready.`)
  const kept: Task = { ...first, state: 'claimed', owner: by, claimedAt: now, calls: 0 }
  const added = [kept, ...others]
  const taskList = run.taskList + 1
  const text = `split #${id} into ${added.map(task => `#${task.id} ${task.title}`).join('; ')}, and claimed #${kept.id}`
  return { run: withEntry({ ...run, tasks: [...tasks, ...added], taskList }, { at: now, by, kind: 'task', text, task: id }), value: { tasks: added, taskList } }
}

/** The task and the tasks above it, up to the top. */
export function ancestorsOf(tasks: readonly Task[], id: number | undefined): number[] {
  const ancestors: number[] = []
  for (let current = taskOf(tasks, id); current && !ancestors.includes(current.id); current = taskOf(tasks, current.parent)) ancestors.push(current.id)
  return ancestors
}

export function claimTask(run: Run, by: WorkerId, id: number, version: number, now: number): Change<Task> {
  const checked = checkTask(run, by, id, version)
  if (isTaskFailure(checked)) return checked
  if (checked.state !== 'open') return failure('TAKEN', `#${id} is ${describeTask(checked)}.`)
  if (isParent(run.tasks, id)) return failure('INVALID', `#${id} has parts, and no worker claims a task with parts. ${openPartsOf(run.tasks, id)}`)
  const need = taskOf(run.tasks, waitsFor(run.tasks, checked))
  if (need) return failure('WAITING', `#${id} waits for #${need.id}, which is ${describeTask(need)}. Claim a task that is ready.`)
  const claimed: Task = { ...checked, state: 'claimed', owner: by, version: checked.version + 1, claimedAt: now, calls: 0, nudged: undefined }
  return updateTask(run, claimed, by, now, `claimed #${id}`)
}

export function releaseTask(run: Run, by: WorkerId, id: number, version: number, note: string, now: number): Change<Task> {
  const checked = checkOwnedTask(run, by, id, version)
  if (isTaskFailure(checked)) return checked
  return updateTask(run, givenBack(checked), by, now, `released #${id}${note ? `: ${note}` : ''}`)
}

export function finishTask(
  run: Run,
  by: WorkerId,
  id: number,
  version: number,
  commit: string,
  summary: string,
  now: number,
  handover: Handover = {},
  { taken, used = [] }: { taken?: number; used?: unknown[] } = {},
): Change<Task> {
  const found = checkTask(run, by, id, version)
  if (isTaskFailure(found)) return found
  if (isParent(run.tasks, id)) return failure('INVALID', `#${id} has parts: it has no commit of its own, and it is done when all its parts are done. ${openPartsOf(run.tasks, id)}`)
  const checked = checkOwnedTask(run, by, id, version)
  if (isTaskFailure(checked)) return checked
  const interfaces = handover.interfaces?.trim() ?? ''
  const unfinished = handover.unfinished?.trim() ?? ''
  const tooLong = lengthFailure('interfaces text', interfaces) ?? lengthFailure('unfinished text', unfinished)
  if (tooLong) return tooLong
  const handed = [
    ...(interfaces ? [{ at: now, kind: 'interface' as const, by, text: `#${id}: ${interfaces}`, commit, files: [] }] : []),
    ...(unfinished ? [{ at: now, kind: 'fact' as const, by, text: `#${id} unfinished: ${unfinished}`, commit, files: [] }] : []),
  ].reduce(withContext, run)
  const kept: Handover = { ...(interfaces ? { interfaces } : {}), ...(unfinished ? { unfinished } : {}) }
  const cited = contextOf(run)
    .map(entry => entry.id)
    .filter(entryId => used.includes(entryId))
  const done: Task = {
    ...checked,
    state: 'done',
    commit,
    summary,
    ...(interfaces || unfinished ? { handover: kept } : {}),
    ...(taken === undefined ? {} : { taken }),
    ...(cited.length ? { used: cited } : {}),
    version: checked.version + 1,
    doneAt: now,
  }
  return updateTask({ ...handed, nudges: 0 }, done, by, now, `finished #${id}: ${summary}`, commit)
}

/**
 * The finished tasks whose commits the integration line does not hold, in the order they were done: done leaves with a
 * commit. A run that meld 0.7.0 stored has no line, so all its finished tasks are here.
 */
export function lackingTasks(run: Run): Task[] {
  const held = new Set(run.line?.tasks ?? [])
  return run.tasks
    .filter(task => task.state === 'done' && task.commit && !isParent(run.tasks, task.id) && !held.has(task.id))
    .sort((a, b) => (a.doneAt ?? 0) - (b.doneAt ?? 0) || a.id - b.id)
}

/** The lacking tasks with no task "integrate #N" for them. A finish_task merges its own task into the line when it is one of them. */
export function unmergedTasks(run: Run): Task[] {
  const integrated = new Set(run.tasks.map(task => task.integrates))
  return lackingTasks(run).filter(task => !integrated.has(task.id))
}

/** The facts of one merge for its log entry: when it began, the worker whose finish started it, and the files the line got. */
export type MergeFacts = { from?: number; worker?: WorkerId; files?: string[] }

/**
 * meld merged the commit of #id into the line: the line moves to `head`, and holds #id and each task that #id integrates.
 * A merge entry at `now`, the end of the merge, records it.
 */
export function lineMerged(run: Run, id: number, head: string, now: number, merge: MergeFacts = {}): Run {
  const held = [...(run.line?.tasks ?? [])]
  for (let task = taskOf(run.tasks, id); task && !held.includes(task.id); task = taskOf(run.tasks, task.integrates)) held.push(task.id)
  if (!held.includes(id)) held.push(id)
  const line: Line = { head, tasks: held }
  return withEntry({ ...run, line }, { at: now, by: 'you', kind: 'merge', text: `merged #${id} into the integration line`, commit: head, task: id, ...merge })
}

/** The machine slept from `from` to `now`: a host entry at the wake records it, so the lanes show the sleep. */
export function machineSlept(run: Run, from: number, now: number): Run {
  return withEntry(run, { at: now, by: 'you', kind: 'host', from, text: `the machine slept for ${Math.round((now - from) / 60_000)} min` })
}

/** The commit of #id does not merge into the line: meld adds a task "integrate #id" of size S, open for any worker. */
export function addIntegrateTask(run: Run, id: number, detail: string, now: number): Change<Task> {
  const ended = endedFailure(run)
  if (ended) return ended
  const added = newTasks(run.tasks, [{ title: `integrate #${id}`, detail, size: 'S' }], now)
  if (!Array.isArray(added) || !added[0]) return Array.isArray(added) ? failure('INVALID', `#${id} has nothing to integrate.`) : added
  const task: Task = { ...added[0], integrates: id }
  const text = `added #${task.id} ${task.title}`
  return { run: withEntry({ ...run, tasks: [...run.tasks, task], taskList: run.taskList + 1 }, { at: now, by: 'you', kind: 'task', text }), value: task }
}

/**
 * The handovers that a new agent needs for a task: of each done task that it needs, through its needs and the needs of
 * its ancestors. A need with parts has no commit of its own, so it gives the handovers of its done parts.
 */
export function handoversFor(run: Run, id: number): HandoverView[] {
  const needs = ancestorsOf(run.tasks, id).flatMap(one => taskOf(run.tasks, one)?.needs ?? [])
  const done = [...new Set(needs.flatMap(need => leavesOf(run.tasks, need)))]
  return done.flatMap(leaf => {
    const task = taskOf(run.tasks, leaf)
    return task?.state === 'done' ? [{ task: task.id, title: task.title, ...(task.commit ? { commit: task.commit } : {}), ...task.handover }] : []
  })
}

/** The handovers that the claims of a worker need, each done task one time. */
function handoversOfClaims(run: Run, by: WorkerId): HandoverView[] {
  const handovers = run.tasks.filter(task => isClaimedBy(task, by)).flatMap(task => handoversFor(run, task.id))
  return handovers.filter((handover, index) => handovers.findIndex(one => one.task === handover.task) === index)
}

/** The task, or the leaves under it when it has parts. */
function leavesOf(tasks: readonly Task[], id: number): number[] {
  const parts = childrenOf(tasks, id)
  return parts.length ? parts.flatMap(part => leavesOf(tasks, part.id)) : [id]
}

/** A task as a reply to a worker shows it: its handover goes only to the agents of the tasks that need it. */
function taskView({ handover: _handover, ...task }: Task): Task {
  return task
}

export function addNote(run: Run, by: WorkerId, text: string, commit: string | undefined, now: number): Change<Entry> {
  const ended = actingFailure(run, by)
  if (ended) return ended
  const next = withEntry(run, { at: now, by, kind: 'note', text, commit })
  return { run: next, value: lastEntry(next) }
}

/** Adds an entry to the shared context. An entry that names an older entry in `replaces` takes the place of that entry. */
export function shareEntry(run: Run, by: WorkerId, input: ShareInput, now: number): Change<ContextEntry> {
  const ended = actingFailure(run, by)
  if (ended) return ended
  const kind = CONTEXT_KINDS.find(one => one === input.kind)
  if (!kind) return failure('INVALID', `The kind is fact, fail or interface, not "${input.kind}".`)
  const text = input.text.trim()
  if (!text) return failure('INVALID', 'The text is empty.')
  const tooLong = lengthFailure('text', text)
  if (tooLong) return tooLong
  if (input.replaces !== undefined && !contextOf(run).some(entry => entry.id === input.replaces)) {
    return failure('NOT_FOUND', `There is no entry ${input.replaces} to replace.`)
  }
  const shared = withContext(run, { at: now, kind, by, text, commit: input.commit, files: input.files ?? [], replaces: input.replaces })
  const entry = lastContext(shared)
  const logged = input.replaces === undefined ? `shared ${kind} ${entry.id}` : `shared ${kind} ${entry.id}, which replaces ${input.replaces}`
  return { run: withEntry(shared, { at: now, by, kind: 'share', text: logged, commit: entry.commit }), value: entry }
}

/** The current entries, newest first. An entry that a newer entry replaces is not current. */
export function currentContext(run: Run, limit = CONTEXT_SHOWN): ContextEntry[] {
  const context = contextOf(run)
  const replaced = new Set(context.map(entry => entry.replaces))
  return context
    .filter(entry => !replaced.has(entry.id))
    .reverse()
    .slice(0, limit)
}

/**
 * The context that a board reply carries to a worker, newest first. The first reply to a new agent carries the current
 * entries, CONTEXT_SHOWN at most; each later reply carries only the current entries that are new since the last reply,
 * other than the entries of the worker. Each entry that a reply carries counts the worker as a reader, unless the worker
 * wrote it, so seenBy names the workers that got the entry, and a delivered entry at `now` records each new reader.
 */
export function passContext(run: Run, by: WorkerId, now: number): { run: Run; context: ContextView[] } {
  const you = findWorker(run, by)
  const carried = new Set(newContextFor(run, you).map(entry => entry.id))
  const fresh = contextOf(run).filter(entry => carried.has(entry.id) && entry.by !== by && !entry.seenBy.includes(by))
  const context = contextOf(run).map(entry => (fresh.includes(entry) ? { ...entry, seenBy: [...entry.seenBy, by] } : entry))
  const logged = fresh.reduce(
    (current, entry) => withEntry(current, { at: now, by: 'you', kind: 'delivered', text: `delivered context ${entry.id} to ${by}`, worker: by, context: entry.id }),
    run,
  )
  const passed = replaceWorker({ ...logged, context }, { ...you, seenContext: context.at(-1)?.id ?? 0 })
  return { run: passed, context: context.filter(entry => carried.has(entry.id)).reverse().map(viewOf) }
}

/** The current entries that are new for the agent of a worker: all of them, CONTEXT_SHOWN at most, before its first reply. */
function newContextFor(run: Run, worker: Worker): ContextEntry[] {
  const seen = worker.seenContext
  if (seen === undefined) return currentContext(run)
  return currentContext(run, Infinity).filter(entry => entry.id > seen && entry.by !== worker.id)
}

export function addCheck(run: Run, by: WorkerId, check: CheckInput, now: number): Change<Entry> {
  const ended = actingFailure(run, by)
  if (ended) return ended
  const entry = { at: now, by, kind: 'check' as const, text: check.command, detail: check.output.slice(-800), commit: check.commit, passed: check.passed }
  const next = withEntry(run, entry)
  return { run: next, value: lastEntry(next) }
}

export function takeIntegration(run: Run, by: WorkerId, now: number): Change<WorkerId> {
  const ended = actingFailure(run, by)
  if (ended) return ended
  if (run.integrator && run.integrator !== by) {
    return failure('INTEGRATION_TAKEN', `${run.integrator} integrates. Do other useful work, or end your turn.`)
  }
  return { run: withEntry({ ...run, integrator: by }, { at: now, by, kind: 'event', text: `${by} integrates` }), value: by }
}

/**
 * The work that the final commit must hold: each done task with a commit, as a part, an integrate task or a task that
 * finished after the merge of the line. A parent has no commit of its own.
 */
export function doneWork(run: Run): Task[] {
  return run.tasks.filter(task => task.state === 'done' && Boolean(task.commit))
}

export function declareFinal(run: Run, by: WorkerId, commit: string, summary: string, now: number): Change<Final> {
  const ended = actingFailure(run, by)
  if (ended) return ended
  if (run.integrator !== by) {
    return failure('NOT_INTEGRATOR', run.integrator ? `${run.integrator} integrates, not you.` : 'Take the integration first.')
  }
  const final: Final = { commit, summary, by }
  const ready = withEntry({ ...run, final, state: 'ready' }, { at: now, by, kind: 'event', text: `final commit: ${summary}`, commit })
  return { run: ready, value: final }
}

/**
 * The person changes the request, and a ready run works again with no final commit. `lineAt` is the commit that meld
 * moved the integration line to first. A ready run takes the steer only when that is its final commit: the line then
 * holds the done tasks at that commit, so the work of the final commit stays in the next one, and the merges after the
 * steer build on it. Else the steer fails with LINE_NOT_MOVED, as when the integrator declared the final commit after
 * the steer read a working run.
 */
export function steer(run: Run, text: string, now: number, lineAt?: string): Change<number> {
  if (!STEERABLE.has(run.state)) return failure('RUN_ENDED', `The run is ${run.state}.`)
  const final = run.state === 'ready' ? run.final?.commit : undefined
  if (final && lineAt !== final) {
    return failure(
      'LINE_NOT_MOVED',
      `The run is ready, and the integration line is not at its final commit ${final.slice(0, 7)}, so a steer now would lose the work of that commit. Steer again: meld moves the line first.`,
    )
  }
  const revision = run.revision + 1
  const kept = final ? { line: { head: final, tasks: run.tasks.filter(task => task.state === 'done').map(task => task.id) } } : {}
  const reopened: Run = { ...run, ...kept, revision, state: run.state === 'ready' ? 'working' : run.state, final: undefined, nudges: 0 }
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

export function boardFor(run: Run, by: WorkerId, now: number): { run: Run; view: BoardView } {
  const you = findWorker(run, by)
  const steers = unseenSteers(run, you)
  const news = run.log.filter(entry => entry.id > you.seenEntry && entry.by !== by && entry.by !== 'you')
  const passed = passContext(run, by, now)
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
    tasks: run.tasks.map(taskView),
    news,
    context: passed.context,
    integrator: run.integrator,
    final: run.final,
    ...nonEmpty('handovers', handoversOfClaims(run, by)),
  }
  const seen: Worker = { ...findWorker(passed.run, by), seenRevision: run.revision, seenEntry: passed.run.log.at(-1)?.id ?? 0 }
  return { run: replaceWorker(passed.run, seen), view }
}

/**
 * Working workers whose agents ended are idle: meld saw no end of their turn. An agent that the engine no longer lists
 * counts as ended only when its worker did nothing since `before`, as a new agent may not be listed yet.
 */
/** Each working worker of `owns` whose agent ended, or is unknown and quiet since `before`, becomes idle. */
export function settleEnded(run: Run, agents: ReadonlyMap<string, AgentState>, before: number, now: number, owns: (worker: Worker) => boolean = () => true): Run {
  const ended = run.workers.filter(
    worker => owns(worker) && worker.state === 'working' && worker.agentId && !resumedSince(worker, before) && hasEnded(agents.get(worker.agentId), worker.activityAt < before),
  )
  return ended.reduce((current, worker) => setWorkerState(current, worker.id, 'idle', now), run)
}

function resumedSince(worker: Worker, at: number): boolean {
  return worker.resumedAt !== undefined && worker.resumedAt >= at
}

function hasEnded(state: AgentState | undefined, isQuiet: boolean): boolean {
  return state === 'ended' || (state === undefined && isQuiet)
}

export function countNudge(run: Run): Run {
  return { ...run, nudges: run.nudges + 1 }
}

export function setActivity(run: Run, by: WorkerId, activity: string, now: number): Run {
  const worker = findWorker(run, by)
  return replaceWorker(run, { ...worker, activity, activityAt: now })
}

/** The most words of the said sentence of an agent. */
const SAID_WORDS = 20

/** The first sentence of a text of an agent, cut to SAID_WORDS words with an ellipsis; undefined for a text with no words. */
export function saidOf(text: string): string | undefined {
  const words = (text.trim().split(/(?<=[.!?])\s|\n/)[0] ?? '').split(/\s+/).filter(Boolean)
  if (!words.length) return undefined
  return words.length > SAID_WORDS ? `${words.slice(0, SAID_WORDS).join(' ')}...` : words.join(' ')
}

/** The agent of a worker wrote text: its first sentence is the said of the worker. A text with no words changes nothing. */
export function setSaid(run: Run, by: WorkerId, text: string | undefined, now: number): Run {
  const said = text === undefined ? undefined : saidOf(text)
  return said ? replaceWorker(run, { ...findWorker(run, by), said, saidAt: now }) : run
}

export function setWorkerState(run: Run, by: WorkerId, state: WorkerState, now: number): Run {
  const worker = findWorker(run, by)
  if (worker.state === 'stopped') return run
  const changed = replaceWorker(run, { ...worker, state, activityAt: now })
  return state === worker.state || state === 'starting' ? changed : withWorkerEntry(changed, by, state, now, `${by} is ${state}`)
}

export function stopWorker(run: Run, by: WorkerId, now: number): Run {
  const worker = findWorker(run, by)
  const tasks = run.tasks.map(task => (task.state === 'claimed' && task.owner === by ? givenBack(task) : task))
  const integrator = run.integrator === by ? undefined : run.integrator
  const stopped = replaceWorker({ ...run, tasks, integrator }, { ...worker, state: 'stopped', activity: 'stopped', activityAt: now })
  return withWorkerEntry(stopped, by, 'stopped', now, `stopped ${by}`)
}

export function stopRun(run: Run, now: number): Run {
  if (!ACTIVE.has(run.state)) return run
  const workers = run.workers.map(worker => ({ ...worker, state: 'stopped' as const, activity: 'stopped', activityAt: now }))
  return withEntry({ ...run, state: 'stopped', endedAt: now, workers }, { at: now, by: 'you', kind: 'event', text: 'stopped the run' })
}

/** A new session takes the run, as a resume does: the cost of the run counts from the cost of that session now. */
export function adoptRun(run: Run, costAtStart: number | undefined, now: number): Run {
  return withEntry({ ...run, costAtStart }, { at: now, by: 'you', kind: 'event', text: 'resumed in a new session' })
}

export function markDelivered(run: Run, now: number): Run {
  return withEntry({ ...run, state: 'delivered', endedAt: now }, { at: now, by: 'you', kind: 'event', text: 'delivered the final commit' })
}

function unseenSteers(run: Run, worker: Worker): string[] {
  return run.log.filter(entry => entry.kind === 'steer' && (entry.revision ?? 0) > worker.seenRevision).map(entry => entry.text)
}

/** The field with its list, or no field when the list is empty, so a reply carries no empty list. */
export function nonEmpty<K extends string, T>(key: K, list: T[]): { [P in K]?: T[] } {
  return (list.length ? { [key]: list } : {}) as { [P in K]?: T[] }
}

function failure(error: ErrorCode, message: string): Failure {
  return { error, message }
}

/** A refusal of a call that saw an old task list: it gives the current tasks and the version to use. */
function staleTasks(run: Run, error: ErrorCode, message: string): Failure {
  return { error, message, taskList: run.taskList, tasks: run.tasks }
}

/** Why a worker changes nothing on the board: the run ended, or the person stopped the worker, whose agent can still call. */
function actingFailure(run: Run, by: WorkerId): Failure | undefined {
  const stopped = run.workers.find(worker => worker.id === by)?.state === 'stopped'
  return endedFailure(run) ?? (stopped ? failure('WORKER_STOPPED', `The person stopped ${by}. End your turn now with a one-line summary.`) : undefined)
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

/** The id of a run: the start time in base 36, so the ids sort by time, then one random base-36 character for each byte. */
export function runId(now: number, bytes: Uint8Array): string {
  return now.toString(36) + Array.from(bytes, byte => (byte % 36).toString(36)).join('')
}

/** A worker as meld makes it: no agent yet, nothing read, nothing counted. */
function newWorker(worker: StartInput['workers'][number], now: number): Worker {
  return { id: worker.id, agent: worker.agent, path: worker.path, ref: worker.ref, state: 'starting', briefed: false, seenRevision: 1, seenEntry: 0, activity: 'starting', activityAt: now, tokens: 0, calls: 0 }
}

/** A worker joins a run that starts or works, when the person asks. A run that ended, or that has the id, stays as it is. */
export function addWorker(run: Run, worker: StartInput['workers'][number], now: number): Run {
  if (!ACTIVE.has(run.state) || run.workers.some(one => one.id === worker.id)) return run
  return withEntry({ ...run, workers: [...run.workers, newWorker(worker, now)] }, { at: now, by: 'you', kind: 'event', text: `${worker.id} joined the run` })
}

function withEntry(run: Run, entry: Omit<Entry, 'id'> & { by: Author }): Run {
  const id = (run.log.at(-1)?.id ?? 0) + 1
  return { ...run, log: [...run.log, { ...entry, id }].slice(-LOG_LIMIT) }
}

/**
 * A record of the lane of a worker: its new state, or a start of its agent. A restart or a resume that finds no ready task,
 * no claim of the worker and no integration of the worker has noTask.
 */
function withWorkerEntry(run: Run, worker: WorkerId, state: LaneState, now: number, text: string, start?: StartReason): Run {
  const again = start === 'restart' || start === 'resume'
  const noTask = again && !claimable(run.tasks).length && !run.tasks.some(task => isClaimedBy(task, worker)) && run.integrator !== worker
  return withEntry(run, { at: now, by: 'you', kind: 'worker', text, worker, state, ...(start && { start }), ...(noTask && { noTask }) })
}

function withContext(run: Run, entry: Omit<ContextEntry, 'id' | 'seenBy'>): Run {
  const context = contextOf(run)
  const id = (context.at(-1)?.id ?? 0) + 1
  return { ...run, context: [...context, { ...entry, id, seenBy: [] }].slice(-CONTEXT_KEPT) }
}

function contextOf(run: Run): ContextEntry[] {
  return run.context ?? []
}

function lastContext(run: Run): ContextEntry {
  const entry = contextOf(run).at(-1)
  if (!entry) throw new Error('meld: the context is empty')
  return entry
}

function viewOf({ at: _at, ...view }: ContextEntry): ContextView {
  return view
}

function lengthFailure(field: string, text: string): Failure | undefined {
  return text.length > CONTEXT_TEXT_LIMIT ? failure('INVALID', `The ${field} has ${text.length} characters. The limit is ${CONTEXT_TEXT_LIMIT}.`) : undefined
}

function lastEntry(run: Run): Entry {
  const entry = run.log.at(-1)
  if (!entry) throw new Error('meld: the log is empty')
  return entry
}

function isTaskFailure(value: Task | Failure): value is Failure {
  return 'error' in value
}

function checkTask(run: Run, by: WorkerId, id: number, version: number): Task | Failure {
  const ended = actingFailure(run, by)
  if (ended) return ended
  const task = run.tasks.find(one => one.id === id)
  if (!task) return failure('NOT_FOUND', `There is no task #${id}.`)
  if (task.version !== version) {
    return failure('STALE_VERSION', `#${id} is at version ${task.version} and is ${describeTask(task)}. Read the board, then try again.`)
  }
  return task
}

function isClaimedBy(task: Task, by: WorkerId): boolean {
  return task.state === 'claimed' && task.owner === by
}

function checkOwnedTask(run: Run, by: WorkerId, id: number, version: number): Task | Failure {
  const task = checkTask(run, by, id, version)
  if (isTaskFailure(task)) return task
  if (task.state !== 'claimed' || task.owner !== by) return failure('NOT_OWNER', `#${id} is ${describeTask(task)}, not claimed by you.`)
  return task
}

function updateTask(run: Run, task: Task, by: WorkerId, now: number, text: string, commit?: string): Change<Task> {
  const tasks = withReadyTimes(withDoneParents(run.tasks.map(one => (one.id === task.id ? task : one)), now), now)
  return { run: withEntry({ ...run, tasks }, { at: now, by, kind: 'task', text, commit, task: task.id }), value: task }
}

/** A task back to open: a release, or the stop of its owner. */
function givenBack(task: Task): Task {
  return { ...task, state: 'open', owner: undefined, claimedAt: undefined, releases: (task.releases ?? 0) + 1, version: task.version + 1 }
}

/** Marks done each parent whose parts are all done, from the lowest parent up. */
function withDoneParents(tasks: Task[], now: number): Task[] {
  const parent = tasks.find(task => task.state !== 'done' && isParent(tasks, task.id) && childrenOf(tasks, task.id).every(part => part.state === 'done'))
  if (!parent) return tasks
  return withDoneParents(tasks.map(task => (task.id === parent.id ? { ...task, state: 'done' as const, doneAt: now, version: task.version + 1 } : task)), now)
}

/** The parts of a parent that are not done, with their state. */
function openPartsOf(tasks: readonly Task[], id: number): string {
  const open = childrenOf(tasks, id).filter(part => part.state !== 'done')
  return open.length ? `Its open parts: ${open.map(part => `#${part.id} (${describeTask(part)})`).join(', ')}.` : 'All its parts are done.'
}

/** Gives the time to each task that is ready now and has no ready time. A task that meld 0.6.0 added has no times, and gets none. */
function withReadyTimes(tasks: Task[], now: number): Task[] {
  return tasks.map(task => (task.addedAt !== undefined && task.readyAt === undefined && isReady(tasks, task) ? { ...task, readyAt: now } : task))
}

function describeTask(task: Task): string {
  if (task.state === 'open') return 'open'
  if (task.state === 'done') return task.owner ? `done by ${task.owner}` : 'done'
  return `claimed by ${task.owner}`
}
