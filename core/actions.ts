import type { AgentContext, BoardView, Change, Facts, Failure, Final, NewTask, PaneView, Run, Task, TaskSize, VcsKind, Worker, WorkerId, WorkerState } from '../types'
import * as board from './board'
import { COMPACT_KEEP, CONTROL_TOOLS, HAND_BACK, integrateDetail, integrateStep, missingWorkText, splitNudge, STATUS_VIEW, TOOL, wakeText, workerPrompt, workerRules } from './contract'
import type { Control } from './contract'
import { command, GIT_MIN, gitVersion, headCommit, isDirty, isOldGit, repoRoot } from './git'
import type { Archive, Clock, CodeHost, CommandReply, FactsStore, Io, Runner, Spawned, Store, Surface, TokenUsage, ToolCall, ToolReply } from './ports'
import { agentSpecOf, agentsOf, isAcpSpec, MAX_AGENTS, parseStart, WORKER_TYPE } from './options'
import type { StartOptions } from './options'
import { claimable } from './tasks'
import { detectVcs, heldWork, runHome, vcsFor } from './vcs'
import type { Prepared } from './vcs'
import { listed } from './words'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** The tool that ends the run of an agent that meld starts: the guard never refuses it, or the agent cannot end. */
const HANDBACK_TOOL = 'SubagentHandback'
const COMMIT_TOOLS = new Set<string>([TOOL.finishTask, TOOL.check, TOOL.finish])
const OPEN_WORK_TOOLS = new Set<string>([TOOL.addTasks, TOOL.split, TOOL.release])
/** The states of a run whose agents can still work. */
export const LIVE_STATES: ReadonlySet<string> = new Set(['starting', 'working', 'ready'])
const ACTIVE_RUN = new Set(['starting', 'working'])
const BIND_POLL_MS = 200
const BIND_POLLS = 100
const NUDGE_LIMIT = 3
const STUCK_TOAST = 'meld: three restarts in a row finished no task. Steer the workers or stop the run.'
const LIVENESS_GRACE_MS = 15_000
const JJ_MISSING = 'jj 0.40 or newer is not installed. Use --vcs git or --vcs auto.'
const ARCHIVE_KEPT = 'The run and its workspaces stay.'
export const LEADING_CD = /^(?:\s*cd\s+\S+\s*(?:&&|;)\s*)+/

type Args = Record<string, unknown>
type Refused = { error: string; message: string }
/** The arguments of a tool call with the full commit; for finish, the commits of the done tasks that the final commit holds. */
type Checked = { args: Args; held?: ReadonlySet<string>; taken?: number }
/** The change of a tool call, with what its reply gives beside the value. */
type Made = { run: Run; value: unknown; extra?: object } | Failure

let pendingSpawns = 0
let restarting = false
let starting = false
let merging: Promise<void> = Promise.resolve()
/**
 * The agents that meld told to end and that no worker holds: the agents of a discarded run, and an agent that started
 * while the person stopped its worker or the run. The guard refuses their calls, as no worker of a run guards them.
 */
const retired = new Set<string>()

const STOPPED_YOU = 'meld stopped you. End your turn now.'
/** Why meld bound no agent to a worker of a run that the person discarded during the spawn. */
const RUN_ENDED = 'the run ended'
const STOPPED_CALL = 'meld stopped you. End your turn now with a one-line summary.'
/** ACP tool kinds that change files: the paths of such a call must stay in the folder of the worker. */
const ACP_EDIT_KINDS = new Set(['edit', 'delete', 'move'])

export async function readRun(io: Store): Promise<Run | null> {
  return (await io.read()) ?? null
}

export async function writeRun(io: Store, change: (run: Run) => Run): Promise<Run | null> {
  let written: Run | null = null
  await io.write(run => {
    written = run ? change(run) : null
    return written
  })
  return written
}

/**
 * Writes the run `id` only. A spawn or a merge takes seconds, and the person can discard the run and start another one
 * meanwhile: the write after such a step leaves the other run as it is.
 */
function writeRunOf(io: Store, id: string, change: (run: Run) => Run): Promise<Run | null> {
  return writeRun(io, current => (current.id === id ? change(current) : current))
}

const NO_RUN = { state: 'none', message: 'There is no meld run. The person starts one with /meld <task>.' }

const RUN_ACTIVE = 'A run is active. Deliver, discard or stop it first: /meld-deliver, /meld-discard or /meld-stop, or the meld pane.'

/** One start at a time: a second click on Start comes before the first start saves its run, so the run check cannot see it. */
export async function startRun(io: Io, cwd: string, options: StartOptions): Promise<CommandReply> {
  if (starting) return { text: RUN_ACTIVE }
  starting = true
  try {
    return await startAlone(io, cwd, options)
  } finally {
    starting = false
  }
}

async function startAlone(io: Io, cwd: string, options: StartOptions): Promise<CommandReply> {
  const current = await readRun(io)
  if (current && LIVE_STATES.has(current.state)) return { text: RUN_ACTIVE }
  const old = await oldGit(io, cwd)
  if (old) return { text: old }
  if (current?.state === 'stopped') {
    const kept = await keptWork(io, current)
    if (kept) return { text: kept }
    const unarchived = await dropRun(io, current)
    if (unarchived) return { text: unarchived }
  }
  const named = await namedRepo(io, options.request)
  const repo = named?.repo ?? (await repoRoot(io, cwd))
  if (!repo) return { text: 'meld needs a git repository in the working directory.' }
  const request = named?.task ?? options.request
  const base = await headCommit(io, repo)
  const now = await io.now()
  const id = board.runId(now, io.random(board.RUN_ID_BYTES))
  const ids = options.agents.map((_, index) => `w${index + 1}` as WorkerId)
  const preferred: VcsKind = options.vcs === 'git' ? 'git' : await detectVcs(io, repo)
  if (options.vcs === 'jj' && preferred !== 'jj') return { text: JJ_MISSING }
  const place = { id, repo, base }
  let kind = preferred
  let prepared: Prepared = await vcsFor(kind).prepare(io, place, ids)
  let fallback = ''
  if ('error' in prepared && kind === 'jj' && options.vcs === 'auto') {
    fallback = ` jj failed (${prepared.error}), so the workers use git.`
    kind = 'git'
    prepared = await vcsFor(kind).prepare(io, place, ids)
  }
  if ('error' in prepared) return { text: `meld could not make the workspaces: ${prepared.error}` }
  const workspaces = prepared.workspaces
  const workers = ids.map((wid, index) => ({ id: wid, agent: options.agents[index] ?? { type: 'meld:worker' }, path: workspaces[index]?.path ?? '', ref: workspaces[index]?.ref ?? '' }))
  const run = board.startRun({ id, request, repo, base, vcs: kind, now, costAtStart: await io.cost(), workers })
  await io.write(() => run)
  await io.writeFacts(null)
  void io.openPane(false)
  const refused = await spawnWorkers(io, run)
  if (refused.length === workers.length) return { text: `No worker started: ${refused[0]}.${fallback}` }
  const notStarted = refused.length ? ` ${refused.length} did not start: ${refused[0]}.` : ''
  const dirty = (await isDirty(io, repo)) ? ' Your uncommitted changes are not in their workspaces.' : ''
  return { text: `Run ${id}: ${workers.length} workers on ${kind}, from commit ${base.slice(0, 7)}.${fallback}${notStarted}${dirty}` }
}

/**
 * Why a start cannot go on with the git of the session: the integration line of both adapters merges with git merge-tree
 * --write-tree. Undefined when git is new enough, or when meld cannot read its version, so the start goes on.
 */
async function oldGit(io: CodeHost, cwd: string): Promise<string | undefined> {
  const version = await gitVersion(io, cwd)
  if (!version || !isOldGit(version)) return undefined
  return `meld needs git ${GIT_MIN} or newer for git merge-tree --write-tree, which merges each finished task into the integration line. This git is ${version}. Update git, then start again.`
}

/**
 * Why a new start cannot take the place of a stopped run: its workspaces hold commits or uncommitted edits, or meld
 * cannot read them. Undefined when they hold no work, as after a start that started no worker.
 */
async function keptWork(io: CodeHost, run: Run): Promise<string | undefined> {
  const { commits, edits, unread } = await heldWork(io, run)
  const home = runHome(run.id)
  if (unread.length) {
    const errors = unread.map(entry => `${entry.id}: ${entry.error.split('\n')[0]}`).join('; ')
    return `Run ${run.id} stopped, and meld cannot read its workspaces in ${home} (${errors}), so they can hold work. /meld-discard or Discard in the meld pane removes them, then you can start again.`
  }
  if (!commits && !edits.length) return undefined
  const edited = edits.length ? `, and uncommitted edits in ${listed(edits)}` : ''
  return `Run ${run.id} stopped with work in ${home}: ${commits} commit${commits === 1 ? '' : 's'}${edited}. /meld-discard or Discard in the meld pane removes its workspaces, then you can start again.`
}

/** The start form of the pane: its task, number of agents, model and version control. */
export async function startFromView(io: Io, cwd: string, view: PaneView): Promise<string> {
  const request = view.task.trim()
  if (!request) return 'Write the task first.'
  const started = await startRun(io, cwd, { request, agents: agentsOf(view.agents, view.model), vcs: view.vcs })
  return started.text ?? ''
}

/** `/meld /path/to/repo task` works in that repository; a first word that names no repository is part of the task. */
async function namedRepo(io: CodeHost, request: string): Promise<{ repo: string; task: string } | undefined> {
  const [first = '', ...rest] = request.split(/\s+/)
  if (!first.startsWith('/') || rest.length === 0) return undefined
  const repo = await repoRoot(io, first)
  return repo ? { repo, task: request.slice(first.length).trim() } : undefined
}

/**
 * Starts each worker in its own folder and binds it by the agent id the engine answers. Returns the reasons of the
 * refused spawns, and of the agents that meld could not bind: those workers are refused too, so none stays starting.
 */
async function spawnWorkers(io: Store & Clock & Runner, run: Run, workers: readonly Worker[] = run.workers): Promise<string[]> {
  const refused: string[] = []
  for (const worker of workers) {
    pendingSpawns += 1
    try {
      const spawned = await spawnOne(io, run, worker)
      const now = await io.now()
      const agentId = spawned.agentId
      if (agentId) {
        const unbound = await bindOrRefuse(io, run.id, worker.id, agentId, now)
        if (unbound) {
          refused.push(unbound)
          retire(io, agentId)
        }
      } else {
        const reason = spawned.deny ?? 'the engine started no agent'
        refused.push(reason)
        await writeRunOf(io, run.id, current => board.refuseWorker(current, worker.id, reason, now))
      }
    } finally {
      pendingSpawns = Math.max(0, pendingSpawns - 1)
    }
  }
  return refused
}

/**
 * Binds a new agent to its worker of the run `runId`. A run that ended during the spawn (the integrator declared the final
 * commit, or the person stopped the run) binds no agent: the worker is refused, as a denied spawn is, so that it does not
 * stay starting with no agent, which no beat starts and which keeps the run from being idle. A worker with another agent
 * keeps it, and a run that the person discarded during the spawn binds nothing. Gives the reason when meld bound no agent.
 */
async function bindOrRefuse(io: Store, runId: string, id: WorkerId, agentId: string, now: number): Promise<string | undefined> {
  let reason: string | undefined = RUN_ENDED
  await writeRunOf(io, runId, current => {
    const bound = board.bindWorker(current, id, agentId, now)
    if (!board.isFailure(bound)) {
      reason = undefined
      return bound.run
    }
    const taken = current.workers.some(worker => worker.id === id && worker.agentId)
    reason = taken ? `${id} has another agent` : `the run is ${current.state}`
    return taken ? current : board.refuseWorker(current, id, reason, now)
  })
  return reason
}

async function spawnOne(io: Runner, run: Run, worker: Worker, step?: string): Promise<Spawned> {
  try {
    return await io.spawn({
      prompt: workerPrompt(run, worker.id, step),
      description: `meld ${worker.id}`,
      subagentType: worker.agent.type,
      model: worker.agent.model,
      cwd: worker.path,
    })
  } catch (error) {
    return { deny: String(error) }
  }
}

function runOf<T>(change: Change<T>, fallback: Run): Run {
  return board.isFailure(change) ? fallback : change.run
}

/** A worker can call a tool before its spawn returns its id: wait for the binding while a spawn is pending. */
async function workerWithWait(io: Store & Clock, agentId: string | undefined): Promise<Worker | undefined> {
  if (agentId === undefined) return undefined
  for (let poll = 0; poll < BIND_POLLS; poll++) {
    const run = await readRun(io)
    const worker = run ? board.workerOf(run, agentId) : undefined
    if (worker || pendingSpawns === 0) return worker
    await io.sleep(BIND_POLL_MS)
  }
  return undefined
}

export async function serveTool(io: Io, e: ToolCall, cwd = ''): Promise<ToolReply> {
  const tool = String(e.tool)
  const worker = await workerWithWait(io, e.agentId)
  const control = CONTROL_TOOLS.get(tool)
  if (tool === TOOL.start || control) {
    if (e.agentId !== undefined) return reply({ error: 'NOT_ALLOWED', message: 'Only the main session starts, steers, stops, delivers or discards a meld run, and adds its workers.' })
    const args = e as unknown as Args
    if (!control) return reply(await startFromTool(io, args, cwd))
    return reply({ text: await controlRun(io, control, text(control === 'steer' ? args.text : args.agent)) })
  }
  if (!worker && tool === TOOL.board) return reply((e as unknown as Args).view === STATUS_VIEW ? await statusView(io) : await overview(io))
  if (!worker) return reply({ error: 'NOT_WORKER', message: 'The meld tools are for the meld workers.' })
  const now = await io.now()
  if (tool === TOOL.board) return reply(await readBoard(io, worker.id, now))
  const checked = await withResolvedCommit(io, tool, e as unknown as Args, worker)
  let answer: unknown = { error: 'RUN_ENDED', message: 'There is no meld run.' }
  let nudge: Task | undefined
  await io.write(run => {
    if (!run) return run
    const done = answered(run, worker.id, 'error' in checked ? checked : mutate(run, worker.id, tool, now, checked))
    const passed = board.passContext(done.run, worker.id, now)
    answer = { ...done.answer, context: passed.context }
    const counted = countedCall(passed.run, worker.id, now)
    nudge = counted.task
    return counted.run
  })
  await afterChange(io, worker.id, tool)
  if (tool === TOOL.finishTask) await mergeFinished(io, worker.id, Number((e as unknown as Args).task))
  await sendNudge(io, worker.id, nudge)
  return reply(answer)
}

/**
 * Merges the commit of the task that a finish_task finished into the integration line, with no agent. A merge that
 * conflicts or fails adds a task "integrate #N", and the working peers of the finisher hear of it. A finish merges its
 * own task alone, so its reply waits for one merge, and for the merges of the finishes before it: one merge runs at a
 * time, as the line moves only from the head that a merge read. The done tasks that the line lacks wait for the
 * integrator, and finish refuses a final commit that lacks one of them.
 */
function mergeFinished(io: Store & CodeHost & Clock & Runner, by: WorkerId, id: number): Promise<void> {
  merging = merging.then(() => mergeTask(io, by, id)).catch(() => undefined)
  return merging
}

/** Merges #id when it is a done task that the line lacks, with no task "integrate #id": a finish that leaves its task undone merges nothing. */
async function mergeTask(io: Store & CodeHost & Clock & Runner, by: WorkerId, id: number): Promise<void> {
  const run = await readRun(io)
  const task = run && ACTIVE_RUN.has(run.state) ? board.unmergedTasks(run).find(one => one.id === id) : undefined
  if (!run || !task) return
  const from = await io.now()
  const merged = await vcsFor(run.vcs).mergeIntoLine(io, run, task.commit ?? '', `meld: integrate #${task.id} ${task.title}`)
  const now = await io.now()
  await writeRunOf(io, run.id, current => {
    if (merged.state === 'merged') return board.lineMerged(current, task.id, merged.head, now, { from, worker: by, files: merged.files })
    return runOf(board.addIntegrateTask(current, task.id, integrateDetail(current, task, merged), now), current)
  })
  if (merged.state === 'merged') return
  const after = await readRun(io)
  if (after?.id !== run.id) return
  for (const peer of after.workers) if (peer.id !== by && peer.state === 'working') tell(io, peer, wakeText('There is open work on the board.'))
}

/** A tool call of a worker: the worker works, and the call counts. A call can bring a leaf of the worker to its nudge. */
function countedCall(run: Run, by: WorkerId, now: number): { run: Run; task?: Task } {
  return board.takeSplitNudge(board.countCall(board.setWorkerState(run, by, 'working', now), by), by)
}

async function sendNudge(io: Store & Runner, by: WorkerId, task: Task | undefined): Promise<void> {
  const worker = task ? (await readRun(io))?.workers.find(one => one.id === by) : undefined
  if (task && worker) tell(io, worker, splitNudge(task.id))
}

/** A refusal leaves the run as it was; a change answers with its value and the steers that the worker has not seen. */
function answered(run: Run, by: WorkerId, change: Made | Refused): { run: Run; answer: object } {
  if ('error' in change) return { run, answer: change }
  const taken = board.takeNotice(change.run, by)
  return { run: taken.run, answer: { ok: true, value: change.value, ...change.extra, notice: taken.notice } }
}

/** The start tool reads its fields as /meld reads its options, so both refuse the same input. */
async function startFromTool(io: Io, args: Args, cwd: string): Promise<unknown> {
  const flags = (['agents', 'model', 'vcs'] as const).filter(name => text(args[name])).map(name => `--${name} ${text(args[name])}`)
  const options = parseStart([...flags, text(args.request)].join(' '))
  return 'error' in options ? options : startRun(io, cwd, options)
}

/** A plugin tool answers the model with text: the JSON of the value. */
function reply(value: unknown): ToolReply {
  return { result: JSON.stringify(value) }
}

/**
 * The board keeps the full id of the commit that a revision names in the folder of the worker; a final commit with a
 * conflict is refused. For a final commit, the version control reads which done tasks it holds. A share that gives no
 * commit needs no resolve.
 */
async function withResolvedCommit(io: Store & CodeHost, tool: string, args: Args, worker: Worker): Promise<Checked | Refused> {
  if (!COMMIT_TOOLS.has(tool) && !(tool === TOOL.share && text(args.commit))) return { args }
  const run = await readRun(io)
  if (!run) return { args }
  const vcs = vcsFor(run.vcs)
  const revision = text(args.commit)
  const found = revision ? await vcs.resolve(io, run, worker, revision) : undefined
  if (!found) return { error: 'NOT_FOUND', message: `There is no commit "${revision}" in your folder. ${vcs.commitHint}` }
  if (tool === TOOL.finish && found.conflict) {
    return { error: 'CONFLICT', message: `${found.commit.slice(0, 12)} has a conflict. Fix the conflict, commit, and finish with the new commit.` }
  }
  const resolved = { ...args, commit: found.commit }
  if (tool === TOOL.finish) return { args: resolved, held: await heldInFinal(io, run, found.commit) }
  if (tool === TOOL.finishTask) return { args: resolved, taken: await vcs.taken(io, run, found.commit) }
  return { args: resolved }
}

/** The commits of the done tasks that `final` holds, as the version control reads them. */
async function heldInFinal(io: CodeHost, run: Run, final: string): Promise<Set<string>> {
  const commits = board.doneWork(run).map(task => task.commit ?? '')
  const missing = new Set(await vcsFor(run.vcs).missing(io, run, final, commits))
  return new Set(commits.filter(commit => !missing.has(commit)))
}

/** The done tasks whose commits are not in `held`. A task done after the version control read the final commit is not in it. */
function lackingWork(run: Run, held: ReadonlySet<string>): Task[] {
  return board.doneWork(run).filter(task => !held.has(task.commit ?? ''))
}

/**
 * A final commit must hold the commit of every done task: a task finished after the integrator started from the line,
 * or after its merge into the line was skipped, is done on the board and not in the final commit. finish fails with
 * MISSING_WORK, which names the tasks and the steps, and the run stays as it was.
 */
function wholeFinal(run: Run, declared: Change<Final>, held: ReadonlySet<string>): Change<Final> {
  if (board.isFailure(declared)) return declared
  const missing = lackingWork(run, held)
  return missing.length ? { error: 'MISSING_WORK', message: missingWorkText(run, declared.value.commit, missing) } : declared
}

function mutate(run: Run, by: WorkerId, tool: string, now: number, { args, held = new Set(), taken }: Checked): Made {
  switch (tool) {
    case TOOL.addTasks:
      return board.addTasks(run, by, { seen: Number(args.seen), tasks: newTasks(args.tasks) }, now)
    case TOOL.claim:
      return withHandovers(board.claimTask(run, by, Number(args.task), Number(args.version), now))
    case TOOL.split:
      return board.splitTask(run, by, { task: Number(args.task), version: Number(args.version), seen: Number(args.seen), tasks: newTasks(args.tasks) }, now)
    case TOOL.release:
      return board.releaseTask(run, by, Number(args.task), Number(args.version), text(args.note), now)
    case TOOL.finishTask: {
      const shared = { interfaces: optionalText(args.interfaces), unfinished: optionalText(args.unfinished) }
      return withHandBack(board.finishTask(run, by, Number(args.task), Number(args.version), text(args.commit), text(args.summary), now, shared, taken), by)
    }
    case TOOL.note:
      return board.addNote(run, by, text(args.text), args.commit === undefined ? undefined : text(args.commit), now)
    case TOOL.share: {
      const replaces = args.replaces === undefined || args.replaces === null ? undefined : Number(args.replaces)
      return board.shareEntry(run, by, { kind: text(args.kind), text: text(args.text), commit: optionalText(args.commit), files: paths(args.files), replaces }, now)
    }
    case TOOL.check:
      return board.addCheck(run, by, { command: text(args.command), commit: text(args.commit), passed: args.passed === true, output: text(args.output) }, now)
    case TOOL.integrate:
      return board.takeIntegration(run, by, now)
    case TOOL.finish:
      return wholeFinal(run, board.declareFinal(run, by, text(args.commit), text(args.summary), now), held)
    default:
      return { error: 'NOT_FOUND', message: `meld has no tool ${tool}.` }
  }
}

/** A claim answers with the handovers of the done tasks that the claimed task needs, for an agent that starts fresh. */
function withHandovers(change: Change<Task>): Made {
  return board.isFailure(change) ? change : { ...change, extra: board.nonEmpty('handovers', board.handoversFor(change.run, change.value.id)) }
}

/** A finish tells a worker that claims no other task to hand back: meld starts a new agent for the next task. */
function withHandBack(change: Change<Task>, by: WorkerId): Made {
  if (board.isFailure(change) || change.run.tasks.some(task => task.state === 'claimed' && task.owner === by)) return change
  return { ...change, extra: { next: HAND_BACK } }
}

function newTasks(value: unknown): NewTask[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isRecord)
    .map(task => ({
      title: text(task.title),
      detail: task.detail === undefined ? undefined : text(task.detail),
      parent: taskId(task.parent),
      size: sizeOf(task.size),
      needs: taskIds(task.needs),
    }))
    .filter(task => task.title)
}

/** A model can give a task as 3, "3" or "#3". */
function taskId(value: unknown): number | undefined {
  return value === undefined || value === null || value === '' ? undefined : Number(text(value).replace(/^#/, ''))
}

/** A model can give one task, not a list. */
function taskIds(value: unknown): number[] | undefined {
  if (value === undefined || value === null) return undefined
  return (Array.isArray(value) ? value : [value]).map(taskId).filter((id): id is number => id !== undefined)
}

/** The board refuses a size other than S, M or L. */
function sizeOf(value: unknown): TaskSize | undefined {
  return (text(value).trim().toUpperCase() || undefined) as TaskSize | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined ? '' : String(value)
}

function optionalText(value: unknown): string | undefined {
  return text(value) || undefined
}

/** A model can give one path as a string, not as a list. */
function paths(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : []
  return Array.isArray(value) ? value.filter((path): path is string => typeof path === 'string' && path !== '') : []
}

/** The board of a worker; its first read also carries its rules, for an agent of any type. */
async function readBoard(io: Store & Runner, id: WorkerId, now: number): Promise<BoardView | Refused> {
  let view: BoardView | undefined
  let nudge: Task | undefined
  await io.write(run => {
    if (!run) return run
    const seen = board.boardFor(run, id, now)
    const briefed = seen.run.workers.find(worker => worker.id === id)?.briefed ?? true
    view = briefed ? seen.view : { ...seen.view, rules: workerRules(seen.run, id) }
    const counted = countedCall(briefed ? seen.run : board.markBriefed(seen.run, id), id, now)
    nudge = counted.task
    return counted.run
  })
  await sendNudge(io, id, nudge)
  return view ?? { error: 'RUN_ENDED', message: 'There is no meld run.' }
}

/**
 * The compact board of the main session: the task counts, one row for each task and each worker, and the log entries
 * since its last status read.
 */
async function statusView(io: Store & Clock): Promise<unknown> {
  const now = await io.now()
  let status: unknown = NO_RUN
  await io.write(run => {
    if (!run) return run
    const doneIds = new Set(run.tasks.filter(task => task.state === 'done').map(task => task.id))
    const seen = run.sessionSeen ?? 0
    status = {
      id: run.id,
      state: run.state,
      counts: Object.fromEntries((['open', 'claimed', 'done'] as const).map(state => [state, run.tasks.filter(task => task.state === state).length])),
      tasks: run.tasks.map(task => ({ id: task.id, title: task.title, state: task.state, owner: task.owner, needs: (task.needs ?? []).filter(need => !doneIds.has(need)) })),
      workers: run.workers.map(worker => ({
        id: worker.id,
        state: worker.state,
        claims: claimsOf(run, worker).map(task => task.id),
        secondsSinceCall: Math.round((now - worker.activityAt) / 1000),
      })),
      log: run.log.filter(entry => entry.id > seen && !board.isQuiet(entry)).map(({ id, at, by, kind, text, commit, passed }) => ({ id, at, by, kind, text, commit, passed })),
    }
    return { ...run, sessionSeen: run.log.at(-1)?.id ?? seen }
  })
  return status
}

/** What the main session reads of the board: the run as a whole. */
async function overview(io: Store): Promise<unknown> {
  const run = await readRun(io)
  if (!run) return NO_RUN
  return {
    id: run.id,
    state: run.state,
    vcs: run.vcs,
    request: run.request,
    steers: board.steersOf(run),
    workers: run.workers.map(worker => ({
      id: worker.id,
      agent: worker.agent,
      state: worker.state,
      activity: worker.activity,
      ref: worker.ref,
      path: worker.path,
      calls: worker.calls ?? 0,
      tokens: worker.tokens,
    })),
    tasks: run.tasks,
    context: board.currentContext(run),
    integrator: run.integrator,
    nudges: run.nudges,
    final: run.final,
    log: run.log.filter(entry => !board.isQuiet(entry)).slice(-10),
  }
}

async function afterChange(io: Store & Runner & Surface, by: WorkerId, tool: string): Promise<void> {
  const run = await readRun(io)
  if (!run) return
  const peers = run.workers.filter(worker => worker.id !== by)
  if (OPEN_WORK_TOOLS.has(tool)) {
    for (const peer of peers) if (peer.state === 'working') tell(io, peer, wakeText('There is open work on the board.'))
  }
  if (tool === TOOL.finish && run.state === 'ready') {
    for (const peer of peers) if (peer.state === 'working') tell(io, peer, 'The final commit is declared. End your turn now.')
    io.toast('meld: the result is ready. Deliver it with /meld-deliver or from the meld pane.')
  }
}

function tell(io: Runner, worker: Worker, message: string): void {
  if (worker.agentId) void io.send(worker.agentId, message).catch(() => undefined)
}

/** An agent that no worker holds ends: it hears to end its turn, and the guard refuses its calls. */
function retire(io: Runner, agentId: string): void {
  retired.add(agentId)
  void io.send(agentId, STOPPED_YOU).catch(() => undefined)
}

/**
 * The run of an idle worker has ended (the engine drops a spawned agent at its hand-back), so meld starts a new agent
 * for that worker, in its folder, with the step in its prompt. When the person stopped the worker or the run during the
 * start, the new agent takes no place: it ends, and the worker stays as the person left it.
 */
async function restart(io: Store & Clock & Runner & Surface, worker: Worker, step: string): Promise<boolean> {
  const run = await readRun(io)
  if (!run) return false
  if (await resumed(io, run, worker, step)) return true
  pendingSpawns += 1
  try {
    const spawned = await spawnOne(io, run, worker, step)
    const now = await io.now()
    const agentId = spawned.agentId
    if (!agentId) {
      io.toast(`meld: ${worker.id} could not start again: ${spawned.deny ?? 'the engine started no agent'}.`)
      return false
    }
    let bound = false
    await writeRunOf(io, run.id, current => {
      const restarted = board.restartWorker(current, worker.id, agentId, now)
      bound = !board.isFailure(restarted)
      return board.isFailure(restarted) ? current : restarted.run
    })
    if (!bound) retire(io, agentId)
    return bound
  } finally {
    pendingSpawns = Math.max(0, pendingSpawns - 1)
  }
}

/**
 * Affinity: the agent of an idle worker goes on in its own session with the step, while its context leaves room for one
 * more task (board.keepsSession). Else, or when the host cannot reach the agent, the worker gets a fresh agent, and its
 * claim gives that agent the handovers of the tasks that it needs.
 */
async function resumed(io: Store & Clock & Runner, run: Run, worker: Worker, step: string): Promise<boolean> {
  if (!worker.agentId || !board.keepsSession(worker) || !io.resume) return false
  if (!(await io.resume(worker.agentId, step).catch(() => false))) return false
  const now = await io.now()
  await writeRunOf(io, run.id, current => runOf(board.resumeWorker(current, worker.id, now), current))
  return true
}

/**
 * A deny reason for a tool call of a worker, or undefined; records the call as the worker's activity. A hand-back ends
 * the turn of the agent: its worker is idle at once, as meld does not see the end of a turn that a restart started.
 */
export async function guardCall(io: Store & Clock & Runner, e: ToolCall): Promise<string | undefined> {
  if (e.agentId === undefined) return undefined
  if (String(e.tool) === HANDBACK_TOOL) {
    await markWorker(io, e.agentId, 'idle')
    return undefined
  }
  const run = await readRun(io)
  const worker = run ? board.workerOf(run, e.agentId) : undefined
  if (!run || !worker) return retired.has(e.agentId) ? STOPPED_CALL : undefined
  const path = editedPath(e)
  const refusal = refusalOf(run, worker, path ? [path] : [])
  if (refusal) return refusal
  await recordCall(io, worker, describeCall(e))
  return undefined
}

/** Why meld refuses what an ACP worker asks to do, or undefined: the rules of guardCall, for the paths of a call that changes files. */
export async function acpRefusal(io: Store, agentId: string, ask: { kind: string; paths: readonly string[] }): Promise<string | undefined> {
  const run = await readRun(io)
  const worker = run ? board.workerOf(run, agentId) : undefined
  if (!run || !worker) return STOPPED_CALL
  return refusalOf(run, worker, ACP_EDIT_KINDS.has(ask.kind) ? ask.paths : [])
}

/** A tool call of an ACP worker becomes the activity of its worker, and counts as a call, as a tool call of a subagent does. */
export async function recordActivity(io: Store & Clock & Runner, agentId: string, activity: string): Promise<void> {
  const run = await readRun(io)
  const worker = run ? board.workerOf(run, agentId) : undefined
  if (worker) await recordCall(io, worker, activity)
}

/** A worker that meld mcp runs through ACP: only meld mcp starts it again. */
export function ownedByAcp(worker: Worker): boolean {
  return isAcpSpec(worker.agent)
}

/** A worker that the engine of the main session runs, such as a Claude subagent: only the main session starts it again. */
export function ownedByEngine(worker: Worker): boolean {
  return !isAcpSpec(worker.agent)
}

/** Why meld refuses a call of the worker, or undefined. A stopped worker or run, and a run with its final commit, refuse each call; an edit stays in the folder of the worker. */
function refusalOf(run: Run, worker: Worker, edited: readonly string[]): string | undefined {
  if (worker.state === 'stopped' || run.state === 'stopped') return STOPPED_CALL
  if (run.state === 'ready' || run.state === 'delivered') return 'The meld run has its final commit. End your turn now.'
  const outside = edited.find(path => !isInside(path, worker.path))
  return outside ? `meld: you work in ${worker.path}. Edit ${moved(outside, run.repo, worker.path)} instead.` : undefined
}

/** Records a call as the activity of the worker and counts it; a worker with many calls on one task gets a nudge to split it. */
async function recordCall(io: Store & Clock & Runner, worker: Worker, activity: string): Promise<void> {
  const now = await io.now()
  let nudge: Task | undefined
  await writeRun(io, current => {
    const counted = countedCall(board.setActivity(current, worker.id, activity, now), worker.id, now)
    nudge = counted.task
    return counted.run
  })
  await sendNudge(io, worker.id, nudge)
}

function editedPath(e: ToolCall): string | undefined {
  if (!EDIT_TOOLS.has(String(e.tool))) return undefined
  const args = e as unknown as Args
  const path = args.file_path ?? args.notebook_path
  return typeof path === 'string' ? path : undefined
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`) || path.startsWith(`/private${root}/`)
}

function moved(path: string, repo: string, root: string): string {
  return path.startsWith(`${repo}/`) ? `${root}${path.slice(repo.length)}` : `a path under ${root}`
}

function describeCall(e: ToolCall): string {
  const tool = String(e.tool)
  const args = e as unknown as Args
  if (tool === 'Bash') return `Bash: ${text(args.command).replace(LEADING_CD, '').slice(0, 60)}`
  const path = text(args.file_path ?? args.notebook_path ?? args.path ?? args.pattern)
  return path ? `${tool} ${path.split('/').pop()}` : tool
}

/** Why meld approves the start of its own worker, as the permission check records it. */
export const SPAWN_APPROVAL = 'meld starts a worker of a run that the person started.'

/**
 * The verdict on an Agent call. Auto mode's classifier allows a call that it links to the person's request. A spawn that
 * a plugin makes carries no request, so the classifier gives no verdict and the spawn fails. A mod may approve an
 * action, so meld approves its own spawn while its run lives. Each action of the worker still goes through the mode.
 * Every other verdict stands: a deny from a rule, the ceiling of the organization, and each call that meld did not raise.
 */
export function spawnVerdict<V extends { decision: string }>(verdict: V, plugin: string, run: Run | null): V | { decision: 'allow'; reason: string } {
  if (verdict.decision !== 'ask' || plugin !== 'meld' || !run || !LIVE_STATES.has(run.state)) return verdict
  return { decision: 'allow', reason: SPAWN_APPROVAL }
}

export const VCS_APPROVAL = 'meld lets a worker run its version control in its own folder.'

/**
 * The commands of the guides of contract.ts, by program: the option that names the folder, and the subcommands. None of
 * them reaches a remote or changes the config.
 */
const WORKER_VCS: Readonly<Record<string, { folder: string; commands: ReadonlySet<string> }>> = {
  git: { folder: '-C', commands: new Set(['status', 'diff', 'log', 'show', 'add', 'commit', 'rev-parse', 'ls-files', 'merge', 'cherry-pick']) },
  jj: { folder: '-R', commands: new Set(['status', 'st', 'log', 'diff', 'show', 'commit', 'new', 'workspace update-stale']) },
}

/**
 * Options that write a file anywhere, read outside the repository, run a program (jj takes --config and --tool after
 * the subcommand too), or name a second folder.
 */
const OUTSIDE_OPTIONS = ['--output', '--no-index', '--config', '--tool', '-R', '--repository']

/**
 * The verdict on a Bash call. The shell of a worker starts in the folder of the session, not in its own folder, so a
 * worker runs `git -C <its folder>` or `jj -R <its folder>`, and the engine asks a person for that form. With no person
 * to ask, a worker could not commit. meld allows the call when the folder is the worker's own (a workspace of the
 * person's repository that meld made), the subcommand is in WORKER_VCS, and the command holds no shell syntax. Every
 * other verdict stands.
 */
export function vcsVerdict<V extends { decision: string }>(verdict: V, agentId: string | undefined, command: string, run: Run | null): V | { decision: 'allow'; reason: string } {
  const worker = verdict.decision === 'ask' && agentId && run && LIVE_STATES.has(run.state) ? board.workerOf(run, agentId) : undefined
  return worker && isOwnVcs(shellWords(command), worker.path) ? { decision: 'allow', reason: VCS_APPROVAL } : verdict
}

function isOwnVcs(words: string[] | undefined, folder: string): boolean {
  const vcs = words ? WORKER_VCS[words[0] ?? ''] : undefined
  if (!words || !vcs || words[1] !== vcs.folder || words[2]?.replace(/\/+$/, '') !== folder.replace(/\/+$/, '')) return false
  const command = words[3] === 'workspace' ? `workspace ${words[4] ?? ''}` : (words[3] ?? '')
  return vcs.commands.has(command) && !words.slice(3).some(word => OUTSIDE_OPTIONS.some(option => word.startsWith(option)))
}

/** Characters that the shell reads as syntax outside quotes: operators, redirects, substitutions, escapes, globs and comments. */
const SHELL_SYNTAX = ';&|<>()$`\\\n\r*?[]{}~#!'

/**
 * The words of a command, or undefined when the shell would read more than words in it: syntax outside quotes, a
 * substitution or an escape in double quotes, or an open quote. Single quotes keep each character as it is.
 */
export function shellWords(command: string): string[] | undefined {
  const words: string[] = []
  let word: string | undefined
  let quote = ''
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = ''
      else if (quote === '"' && '$`\\'.includes(char)) return undefined
      else word += char
    } else if (char === "'" || char === '"') {
      quote = char
      word ??= ''
    } else if (char === ' ' || char === '\t') {
      if (word !== undefined) words.push(word)
      word = undefined
    } else if (SHELL_SYNTAX.includes(char)) {
      return undefined
    } else {
      word = (word ?? '') + char
    }
  }
  if (quote) return undefined
  return word === undefined ? words : [...words, word]
}

/** The price of a cache read, a cache write and an output token, against an input token. */
const CACHE_READ_PRICE = 0.1
const CACHE_WRITE_PRICE = 1.25
const OUTPUT_PRICE = 5

/**
 * The cost of a model call in input tokens: each kind of token counts at its price against input. Each call reads the
 * whole cached context again, so cache reads can be most of the cost of a long run.
 */
export function costTokens(usage: TokenUsage | undefined): number {
  if (!usage) return 0
  const read = (usage.cache_read_input_tokens ?? 0) * CACHE_READ_PRICE
  return Math.round(usage.input_tokens + read + usage.cache_creation_input_tokens * CACHE_WRITE_PRICE + usage.output_tokens * OUTPUT_PRICE)
}

/** The tokens in the context of a model call: its whole input, the cached part too. */
function contextTokens(usage: TokenUsage): number {
  return usage.input_tokens + usage.cache_creation_input_tokens + (usage.cache_read_input_tokens ?? 0)
}

/**
 * One model call of an agent: its cost in input tokens adds up on its worker at once. A worker does a task in one long turn, so
 * a count at the end of the turn showed 0 tokens while it worked. With the window of the model of the agent, the call
 * also gives the context of the agent. The main session and agents that are no worker count nothing.
 */
export async function countStep(io: Store, agentId: string | undefined, usage: TokenUsage | null | undefined, window?: number): Promise<void> {
  const tokens = costTokens(usage ?? undefined)
  if (agentId === undefined || !usage || !tokens) return
  const run = await readRun(io)
  const worker = run ? board.workerOf(run, agentId) : undefined
  if (!worker) return
  await writeRun(io, current => {
    const counted = board.addTokens(current, worker.id, tokens)
    return window ? board.setContext(counted, worker.id, { used: contextTokens(usage), size: window }) : counted
  })
}

/**
 * The agent of a worker compacts its conversation: its rules were in its first board reply, so its next board read gives
 * them again. Gives what the summary keeps, or undefined for an agent that is no worker.
 */
export async function compactWorker(io: Store, agentId: string): Promise<string | undefined> {
  const run = await readRun(io)
  const worker = run ? board.workerOf(run, agentId) : undefined
  if (!worker) return undefined
  await writeRun(io, current => board.markBriefed(current, worker.id, false))
  return COMPACT_KEEP
}

/** An ACP agent reported its context window. */
export async function recordContext(io: Store, agentId: string, context: AgentContext): Promise<void> {
  const run = await readRun(io)
  const worker = run ? board.workerOf(run, agentId) : undefined
  if (worker) await writeRun(io, current => board.setContext(current, worker.id, context))
}

/** A worker's turn ended: it is idle. Its tokens added up at each model call (countStep). The clock of meld starts workers again (see restartIdleWorkers). */
export async function markWorker(io: Store & Clock, agentId: string | undefined, state: WorkerState, tokens = 0): Promise<void> {
  if (agentId === undefined) return
  const run = await readRun(io)
  const worker = run ? board.workerOf(run, agentId) : undefined
  if (!run || !worker) return
  const now = await io.now()
  await writeRun(io, current => board.addTokens(board.setWorkerState(current, worker.id, state, now), worker.id, tokens))
}

type Restart = { worker: Worker; step: string }

/**
 * One beat of the clock. The run of an idle worker has ended (the engine drops a spawned agent at its hand-back, and an
 * agent hands back after each task), so meld starts a new agent for it when there is work for it: a task that it can
 * claim, one worker for each such task that no pending worker will take (see restartsFor); news on the board that it has not read, for a task of its own; or, with every
 * worker idle, the owners of unfinished tasks, then idle workers for open tasks, else the lead to plan, steer or integrate. Each beat that starts a worker counts; a finished task or a steer resets
 * the count, so after three beats that finish nothing meld stops and tells the person once. One beat runs at a time.
 *
 * Only hooks that no worker needs call it: an agent skips the hook that started it, and an agent that a clock or a
 * button closure starts skips every meld hook, the board and the edit guard included.
 *
 * Each worker has one host that starts it again, so no worker gets two agents: the main session starts the workers of
 * its engine, and meld mcp starts its ACP workers (`owns`).
 */
export async function restartIdleWorkers(io: Store & Clock & Runner & Surface, owns: (worker: Worker) => boolean = ownedByEngine): Promise<WorkerId[]> {
  if (restarting) return []
  restarting = true
  try {
    await settleEnded(io, owns)
    const run = await readRun(io)
    if (!run || run.state !== 'working' || run.nudges > NUDGE_LIMIT) return []
    const restarts = restartsFor(run).filter(restart => owns(restart.worker))
    if (!restarts.length) return []
    await writeRun(io, board.countNudge)
    if (run.nudges === NUDGE_LIMIT) {
      io.toast(STUCK_TOAST)
      return []
    }
    const started: WorkerId[] = []
    for (const { worker, step } of restarts) if (await restart(io, worker, wakeText(step))) started.push(worker.id)
    return started
  } finally {
    restarting = false
  }
}

/** Marks the owned workers whose agents ended as idle. A beat where no agent ended writes nothing. */
async function settleEnded(io: Store & Clock & Runner, owns: (worker: Worker) => boolean): Promise<void> {
  const run = await readRun(io)
  if (!run || run.state !== 'working') return
  const agents = await io.agents()
  if (!agents) return
  const now = await io.now()
  const before = now - LIVENESS_GRACE_MS
  if (board.settleEnded(run, agents, before, now, owns) === run) return
  await writeRun(io, current => board.settleEnded(current, agents, before, now, owns))
}

function everyWorker(): boolean {
  return true
}

/**
 * The restarts of one beat. A working worker with an agent that claims nothing will take an open task: meld started it
 * again for one, or it planned the tasks, and the task stays open until its claim. Such a worker is pending, so the idle
 * workers start for the other open tasks only, and a ready task gets one agent. The integrator integrates and takes no
 * task, and a worker that is starting has no agent yet: neither is pending, so they hold back no idle worker.
 */
function restartsFor(run: Run): Restart[] {
  const live = run.workers.filter(worker => worker.state !== 'stopped')
  const idle = live.filter(worker => worker.state === 'idle')
  const everyoneIdle = idle.length === live.length
  const open = claimable(run.tasks)
  const owners = idle.filter(worker => claimsOf(run, worker).length && (everyoneIdle || hasNews(run, worker)))
  const pending = live.filter(worker => isPending(run, worker)).length
  const takers = idle.filter(worker => !claimsOf(run, worker).length).slice(0, Math.max(0, open.length - pending))
  const restarts = [
    ...owners.map(worker => ({ worker, step: `Your task is not done: ${titles(claimsOf(run, worker))}. Go on with it, or release it with a note.` })),
    ...takers.map(worker => ({ worker, step: `These tasks are open: ${titles(open)}. Claim one and do it.` })),
  ]
  if (restarts.length || !everyoneIdle) return restarts
  const lead = live.find(worker => worker.id === run.integrator) ?? live[0]
  return lead ? [{ worker: lead, step: leadStep(run, lead) }] : []
}

/** A working worker with an agent that claims nothing and does not integrate: it will claim an open task. */
function isPending(run: Run, worker: Worker): boolean {
  return worker.state === 'working' && worker.agentId !== undefined && worker.id !== run.integrator && !claimsOf(run, worker).length
}

/** Board entries the worker has not read: a steer, or an entry of another worker (meld's own restarts are not news). */
function hasNews(run: Run, worker: Worker): boolean {
  return worker.seenRevision < run.revision || run.log.some(entry => entry.id > worker.seenEntry && entry.by !== worker.id && entry.by !== 'you')
}

function claimsOf(run: Run, worker: Worker): Task[] {
  return run.tasks.filter(task => task.state === 'claimed' && task.owner === worker.id)
}

function titles(tasks: Task[]): string {
  return tasks.map(task => `#${task.id} ${task.title}`).join('; ')
}

/** With nothing open or claimed: the last steer when the lead has not read it, a plan when there is none, else the integration. */
function leadStep(run: Run, lead: Worker): string {
  const steer = lead.seenRevision < run.revision ? board.steersOf(run).at(-1) : undefined
  if (steer !== undefined) return `The person changed the request (revision ${run.revision}): ${steer}`
  if (!run.tasks.length && !run.integrator) return `There are no tasks yet. Split the request into tasks with ${TOOL.addTasks}, then claim one.`
  return integrateStep(run, board.lackingTasks(run))
}

/** The tries of a steer: a try fails when the integrator declared the final commit after the try read the run. */
const STEER_TRIES = 3
const NO_RUN_TO_STEER = 'There is no run to steer.'

export async function steerRun(io: Store & CodeHost & Clock & Runner & Surface, instruction: string): Promise<string> {
  if (!instruction) return 'Write the instruction after /meld-steer.'
  let steered = await trySteer(io, instruction)
  for (let tries = 1; steered.again && tries < STEER_TRIES; tries++) steered = await trySteer(io, instruction)
  const revision = steered.revision
  if (!revision) return steered.outcome
  await settleEnded(io, everyWorker)
  const run = await readRun(io)
  if (!run) return NO_RUN_TO_STEER
  const step = wakeText(`The person changed the request (revision ${revision}): ${instruction}`)
  const live = run.workers.filter(worker => worker.state !== 'stopped')
  const running = live.filter(worker => worker.state === 'working')
  for (const worker of running) tell(io, worker, step)
  if (!live.length) return `Revision ${revision}: no worker is left to take it.`
  if (running.length === live.length) return live.length === 1 ? `The worker gets revision ${revision}.` : `All ${live.length} workers get revision ${revision}.`
  if (running.length) {
    const gets = running.length === 1 ? '1 running worker gets it' : `${running.length} running workers get it`
    const others = live.length - running.length === 1 ? 'the other sees it when meld starts it again' : 'the others see it when meld starts them again'
    return `Revision ${revision}: ${gets}; ${others}.`
  }
  const started = await restartIdleWorkers(io)
  if (!started.length) return `Revision ${revision}: every worker has ended, and meld could not start one again.`
  return `Revision ${revision}: meld starts ${started.join(', ')} again with it.`
}

/** One try of a steer: the revision it saved, or why not, and `again` when the line was not at the final commit of a ready run. */
type Steered = { revision: number; outcome: string; again: boolean }

/**
 * One try of a steer: meld moves the line to the final commit of a ready run, then saves the steer. The integrator can
 * declare the final commit after the move read a working run: board.steer then refuses the ready run with
 * LINE_NOT_MOVED, the run stays as it is, and the next try moves the line to that commit.
 */
async function trySteer(io: Store & CodeHost & Clock, instruction: string): Promise<Steered> {
  const line = await lineToFinal(io)
  if ('error' in line) return { revision: 0, outcome: line.error, again: false }
  const now = await io.now()
  let steered: Steered = { revision: 0, outcome: NO_RUN_TO_STEER, again: false }
  await io.write(run => {
    if (!run) return run
    const change = board.steer(run, instruction, now, line.moved)
    if (board.isFailure(change)) {
      steered = { revision: 0, outcome: change.message, again: change.error === 'LINE_NOT_MOVED' }
      return run
    }
    steered = { revision: change.value, outcome: '', again: false }
    return change.run
  })
  return steered
}

/**
 * Before a steer of a ready run, meld moves the integration line to the final commit, so that the steer keeps the work of
 * that commit: the merges after the steer and the next final build on it. The move runs in the chain of merges, as it
 * moves the line too. It gives the commit that the line moved to, nothing for a run that is not ready, or why the line
 * could not move: then the steer changes nothing. The board refuses a steer of a ready run whose line did not move.
 * A steer of a run that is not ready waits for no merge: when the run becomes ready before the steer saves, the board
 * refuses the steer, and the next try moves the line.
 */
async function lineToFinal(io: Store & CodeHost): Promise<{ moved?: string } | { error: string }> {
  const current = await readRun(io)
  if (current?.state !== 'ready' || !current.final) return {}
  const moved = merging.then(async () => {
    const run = await readRun(io)
    if (run?.state !== 'ready' || !run.final) return {}
    const set = await vcsFor(run.vcs).setLine(io, run, run.final.commit)
    if (set.ok) return { moved: run.final.commit }
    const why = (set.err || set.out).split('\n')[0]
    return {
      error: `meld could not move the integration line to the final commit ${run.final.commit.slice(0, 7)} (${why}), and a steer without it would lose the work of that commit. The run stays ready: steer again, or deliver or discard the run.`,
    }
  })
  merging = moved.then(() => undefined).catch(() => undefined)
  return moved
}

export async function stopAll(io: Store & Clock & Runner): Promise<string> {
  const now = await io.now()
  const run = await writeRun(io, current => board.stopRun(current, now))
  if (!run) return 'There is no run.'
  for (const worker of run.workers) tell(io, worker, 'meld stopped the run. End your turn now.')
  return 'Stopped. The workspaces stay until you discard them with /meld-discard or in the meld pane.'
}

export async function stopOne(io: Store & Clock & Runner, id: WorkerId): Promise<string> {
  const now = await io.now()
  const run = await writeRun(io, current => board.stopWorker(current, id, now))
  const worker = run?.workers.find(one => one.id === id)
  if (!run || !worker) return 'There is no run.'
  tell(io, worker, 'meld stopped you. End your turn now.')
  for (const peer of run.workers) {
    if (peer.id !== id && peer.state !== 'stopped') tell(io, peer, wakeText(`The person stopped ${id}. Its claimed tasks are open again.`))
  }
  return `Stopped ${id}.`
}

/** The longest subject of the merge commit of a delivery, with its 'meld: '. */
const SUBJECT_CHARS = 72
const SUBJECT_PREFIX = 'meld: '

/**
 * The message of the merge commit of a delivery. Its subject is 'meld: ' and the summary of the final commit, or the first
 * line of the request when the summary is empty, cut at its last space to 72 characters. Its body holds the full request.
 */
export function deliveryMessage(run: Run): string {
  const summary = run.final?.summary.split('\n')[0]?.trim() || run.request.split('\n')[0]?.trim() || ''
  return `${cutAtSpace(`${SUBJECT_PREFIX}${summary}`, SUBJECT_CHARS)}\n\n${run.request.trim()}`
}

/** The text cut at its last space within the limit; a text with no such space after the prefix is cut at the limit. */
function cutAtSpace(text: string, limit: number): string {
  if (text.length <= limit) return text
  const space = text.slice(0, limit + 1).lastIndexOf(' ')
  return space > SUBJECT_PREFIX.length ? text.slice(0, space).trimEnd() : text.slice(0, limit)
}

const NO_RUN_AT_WORK = 'There is no meld run at work. A worker can join a run that starts or works.'

/** What the main session does to a run with a tool or a command, as the meld pane does. */
export function controlRun(io: Store & CodeHost & FactsStore & Clock & Runner & Surface & Archive, control: Control, input = ''): Promise<string> {
  if (control === 'steer') return steerRun(io, input.trim())
  if (control === 'stop') return stopAll(io)
  if (control === 'deliver') return deliver(io)
  if (control === 'discard') return discard(io)
  return addWorker(io, input.trim())
}

/**
 * A worker joins a live run: the next id, a workspace from the head of the integration line (or the base with no line),
 * and its agent at once. The agent is the one that the person names, else the agent of w1.
 */
export async function addWorker(io: Store & CodeHost & Clock & Runner, agentText: string): Promise<string> {
  const run = await readRun(io)
  if (!run || !ACTIVE_RUN.has(run.state)) return NO_RUN_AT_WORK
  if (run.workers.length >= MAX_AGENTS) return `A run has ${MAX_AGENTS} workers at most.`
  const id = nextWorkerId(run)
  const vcs = vcsFor(run.vcs)
  const made = await vcs.addWorkspace(io, run, id)
  if ('error' in made) return `meld could not make the workspace of ${id}: ${made.error}`
  const agent = agentText ? agentSpecOf(agentText) : (run.workers[0]?.agent ?? { type: WORKER_TYPE })
  const now = await io.now()
  const joined = await writeRunOf(io, run.id, current => board.addWorker(current, { id, agent, path: made.path, ref: made.ref }, now))
  if (joined?.id !== run.id) {
    await vcs.remove(io, { id: run.id, repo: run.repo, workers: [made] })
    return `${id} did not join: the run ended while meld made its workspace.`
  }
  const worker = joined.workers.find(one => one.id === id)
  if (!worker) return NO_RUN_AT_WORK
  const refused = await spawnWorkers(io, joined, [worker])
  if (refused.length) return `${id} joined the run, but its agent did not start: ${refused[0]}.`
  return `${id} joined the run. Its workspace is ${made.path}, from ${run.line ? 'the integration line' : 'the base'}.`
}

function nextWorkerId(run: Run): WorkerId {
  return `w${Math.max(0, ...run.workers.map(worker => Number(worker.id.slice(1)))) + 1}`
}

/**
 * Merges the final commit into the branch of the person. The run is delivered before meld removes its folder, as a
 * board file keeps no delivered run: a worker that ends its turn during the removal does not make the folder again.
 */
export async function deliver(io: Store & CodeHost & Clock & Archive): Promise<string> {
  const run = await readRun(io)
  if (!run || run.state !== 'ready' || !run.final) return 'There is no final commit to deliver.'
  const missing = lackingWork(run, await heldInFinal(io, run, run.final.commit))
  if (missing.length) return lackingDelivery(run.final.commit, missing)
  if (await isDirty(io, run.repo)) return 'Commit or stash the changes in your checkout first, then deliver.'
  const now = await io.now()
  const unarchived = await archiveRun(io, board.markDelivered(run, now))
  if (unarchived) return unarchived
  const vcs = vcsFor(run.vcs)
  const merged = await vcs.deliver(io, run, run.final.commit, deliveryMessage(run))
  if (!merged.ok) return `The merge stopped, and nothing changed: ${merged.err || merged.out}`
  await writeRunOf(io, run.id, current => board.markDelivered(current, now))
  await vcs.remove(io, run)
  return `Merged ${run.final.commit.slice(0, 7)} into your branch.`
}

/** Why Deliver refuses a final commit that lacks the work of done tasks: the tasks, and a steer that makes a new final commit. */
function lackingDelivery(final: string, missing: readonly Task[]): string {
  const one = missing.length === 1
  const tasks = listed(missing.map(task => `#${task.id} ${task.title}`))
  const ids = listed(missing.map(task => `#${task.id}`))
  return `Nothing changed: the final commit ${final.slice(0, 7)} lacks the work of ${tasks}, which ${one ? 'is' : 'are'} done on the board. Steer the run so that an agent merges ${one ? 'it' : 'them'}, for example /meld-steer Merge ${ids} into the final commit. Then deliver the new final commit.`
}

export async function discard(io: Store & CodeHost & FactsStore & Clock & Runner & Archive): Promise<string> {
  const run = await readRun(io)
  if (!run) return 'There is no run.'
  if (LIVE_STATES.has(run.state)) await stopAll(io)
  return (await dropRun(io, run)) ?? 'The run and its workspaces are gone.'
}

/**
 * Archives the run, drops it and its facts, then removes the workspaces of a run that meld did not deliver. The run goes
 * first: a worker that ends its turn during the removal then writes no run, so no board file makes its folder again.
 * Its agents retire, so the guard refuses the calls of an agent that still runs during the removal. When meld cannot
 * write the archive, the run and its workspaces stay, and the reason comes back.
 */
async function dropRun(io: Store & FactsStore & CodeHost & Archive, run: Run): Promise<string | undefined> {
  const latest = await readRun(io)
  const unarchived = await archiveRun(io, latest?.id === run.id ? latest : run)
  if (unarchived) return unarchived
  for (const worker of run.workers) if (worker.agentId) retired.add(worker.agentId)
  await io.write(() => null)
  await io.writeFacts(null)
  if (run.state !== 'delivered') await vcsFor(run.vcs).remove(io, run)
  return undefined
}

/**
 * Writes the record of the run to <archive folder>/<run id>.json, open to its user only: the run, the board (request,
 * steers, tasks), the events and the context entries. The folder is 0700 before the file is there, so no other user
 * reads the file before its chmod. Gives the reason when it could not write the record.
 */
async function archiveRun(io: CodeHost & Archive, run: Run): Promise<string | undefined> {
  const { request, tasks, log, context, ...rest } = run
  const record = { run: rest, board: { request, steers: board.steersOf(run), tasks }, events: log, context: context ?? [] }
  try {
    const folder = await io.archiveFolder()
    const path = `${folder}/${run.id}.json`
    const made = await command(io, run.repo, ['mkdir', '-p', '-m', '700', folder])
    // mkdir -p keeps the mode of a folder that was there, so the chmod closes it before the write.
    const shut = made.ok ? await command(io, run.repo, ['chmod', '700', folder]) : made
    if (shut.ok) await io.writeFile(path, JSON.stringify(record, null, 2))
    const closed = shut.ok ? await command(io, run.repo, ['chmod', '600', path]) : shut
    return closed.ok ? undefined : `meld could not write the archive ${path}: ${closed.err}. ${ARCHIVE_KEPT}`
  } catch (error) {
    return `meld could not write the archive: ${String(error)}. ${ARCHIVE_KEPT}`
  }
}

/** Reads what the version control shows of the run, for the pane: the commits of each worker, and the change of the final commit. */
export async function refreshFacts(io: Store & FactsStore & CodeHost): Promise<void> {
  const run = await readRun(io)
  if (!run || run.state === 'delivered') return
  const vcs = vcsFor(run.vcs)
  const previous = await io.readFacts()
  const lanes = await vcs.lanes(io, run)
  const kept = previous?.run === run.id ? previous.result : undefined
  const result = run.final ? (kept?.commit === run.final.commit ? kept : await vcs.result(io, run, run.final.commit)) : undefined
  const facts: Facts = result ? { run: run.id, lanes, result } : { run: run.id, lanes }
  if (JSON.stringify(facts) !== JSON.stringify(previous)) await io.writeFacts(facts)
}
