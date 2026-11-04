import type { CommandRunResult, ToolCallInput, ToolCallResult, TurnUsage } from 'claude-code'

import type { BoardView, Change, Facts, Failure, Final, NewTask, PaneView, Run, Task, TaskSize, VcsKind, Worker, WorkerId, WorkerState } from '../types'
import * as board from './board'
import { CONTROL_TOOLS, HAND_BACK, integrateDetail, integrateStep, missingWorkText, splitNudge, TOOL, wakeText, workerPrompt, workerRules } from './contract'
import type { Control } from './contract'
import { GIT_MIN, gitVersion, headCommit, isDirty, isOldGit, repoRoot } from './git'
import type { Io, Spawned } from './io'
import { agentSpecOf, agentsOf, MAX_AGENTS, parseStart, WORKER_TYPE } from './options'
import type { StartOptions } from './options'
import { claimable } from './tasks'
import { detectVcs, heldWork, runHome, vcsFor } from './vcs'
import type { Prepared } from './vcs'

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
export const LEADING_CD = /^(?:\s*cd\s+\S+\s*(?:&&|;)\s*)+/

type Args = Record<string, unknown>
type Refused = { error: string; message: string }
/** The arguments of a tool call with the full commit; for finish, the commits of the done tasks that the final commit holds. */
type Checked = { args: Args; held?: ReadonlySet<string> }
/** The change of a tool call, with what its reply gives beside the value. */
type Made = { run: Run; value: unknown; extra?: object } | Failure

let pendingSpawns = 0
let restarting = false
let mirroring: Promise<void> = Promise.resolve()
let merging: Promise<void> = Promise.resolve()

export async function readRun(io: Io): Promise<Run | null> {
  return (await io.read()) ?? null
}

async function writeRun(io: Io, change: (run: Run) => Run): Promise<Run | null> {
  let written: Run | null = null
  await save(io, run => {
    written = run ? change(run) : null
    return written
  })
  return written
}

/** Each write of the run goes through here. After the write, meld mirrors the board. */
async function save(io: Io, change: (run: Run | null) => Run | null): Promise<void> {
  await io.write(change)
  await mirrorBoard(io)
}

/**
 * Writes the board to board.json in the folder of the run, so that the shared context outlives the session. One mirror
 * writes at a time, and each one reads the newest run. A delivered run has no folder, and a failed mirror fails no call.
 */
function mirrorBoard(io: Io): Promise<void> {
  mirroring = mirroring
    .then(async () => {
      const run = await readRun(io)
      if (run && run.state !== 'delivered') await io.writeFile(`${runHome(run.id)}/board.json`, `${JSON.stringify(run, null, 2)}\n`)
    })
    .catch(() => undefined)
  return mirroring
}

export async function startRun(io: Io, cwd: string, options: StartOptions): Promise<CommandRunResult> {
  const current = await readRun(io)
  if (current && LIVE_STATES.has(current.state)) return { text: 'A run is active. Deliver, discard or stop it first: /meld-deliver, /meld-discard or /meld-stop, or the meld pane.' }
  const old = await oldGit(io, cwd)
  if (old) return { text: old }
  if (current?.state === 'stopped') {
    const kept = await keptWork(io, current)
    if (kept) return { text: kept }
    await dropRun(io, current)
  }
  const named = await namedRepo(io, options.request)
  const repo = named?.repo ?? (await repoRoot(io, cwd))
  if (!repo) return { text: 'meld needs a git repository in the working directory.' }
  const request = named?.task ?? options.request
  const base = await headCommit(io, repo)
  const now = await io.now()
  const id = now.toString(36)
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
  await save(io, () => run)
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
async function oldGit(io: Io, cwd: string): Promise<string | undefined> {
  const version = await gitVersion(io, cwd)
  if (!version || !isOldGit(version)) return undefined
  return `meld needs git ${GIT_MIN} or newer for git merge-tree --write-tree, which merges each finished task into the integration line. This git is ${version}. Update git, then start again.`
}

/**
 * Why a new start cannot take the place of a stopped run: its workspaces hold commits or uncommitted edits, or meld
 * cannot read them. Undefined when they hold no work, as after a start that started no worker.
 */
async function keptWork(io: Io, run: Run): Promise<string | undefined> {
  const { commits, edits, unread } = await heldWork(io, run)
  const home = runHome(run.id)
  if (unread.length) {
    const errors = unread.map(lane => `${lane.id}: ${lane.error?.split('\n')[0]}`).join('; ')
    return `Run ${run.id} stopped, and meld cannot read its workspaces in ${home} (${errors}), so they can hold work. /meld-discard or Discard in the meld pane removes them, then you can start again.`
  }
  if (!commits && !edits.length) return undefined
  const edited = edits.length ? `, and uncommitted edits in ${listed(edits)}` : ''
  return `Run ${run.id} stopped with work in ${home}: ${commits} commit${commits === 1 ? '' : 's'}${edited}. /meld-discard or Discard in the meld pane removes its workspaces, then you can start again.`
}

/** Names as a list in words: "w1", "w1 and w2", "w1, w2 and w3". */
function listed(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '')
}

/** The start form of the pane: its task, number of agents, model and version control. */
export async function startFromView(io: Io, cwd: string, view: PaneView): Promise<string> {
  const request = view.task.trim()
  if (!request) return 'Write the task first.'
  const started = await startRun(io, cwd, { request, agents: agentsOf(view.agents, view.model), vcs: view.vcs })
  return started.text ?? ''
}

/** `/meld /path/to/repo task` works in that repository; a first word that names no repository is part of the task. */
async function namedRepo(io: Io, request: string): Promise<{ repo: string; task: string } | undefined> {
  const [first = '', ...rest] = request.split(/\s+/)
  if (!first.startsWith('/') || rest.length === 0) return undefined
  const repo = await repoRoot(io, first)
  return repo ? { repo, task: request.slice(first.length).trim() } : undefined
}

/** Starts each worker in its own folder and binds it by the agent id the engine answers. Returns the reasons of the refused spawns. */
async function spawnWorkers(io: Io, run: Run, workers: readonly Worker[] = run.workers): Promise<string[]> {
  const refused: string[] = []
  for (const worker of workers) {
    pendingSpawns += 1
    try {
      const spawned = await spawnOne(io, run, worker)
      const now = await io.now()
      const agentId = spawned.agentId
      if (agentId) await writeRun(io, current => runOf(board.bindWorker(current, worker.id, agentId, now), current))
      else {
        const reason = spawned.deny ?? 'the engine started no agent'
        refused.push(reason)
        await writeRun(io, current => board.refuseWorker(current, worker.id, reason, now))
      }
    } finally {
      pendingSpawns = Math.max(0, pendingSpawns - 1)
    }
  }
  return refused
}

async function spawnOne(io: Io, run: Run, worker: Worker, step?: string): Promise<Spawned> {
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
async function workerWithWait(io: Io, agentId: string | undefined): Promise<Worker | undefined> {
  if (agentId === undefined) return undefined
  for (let poll = 0; poll < BIND_POLLS; poll++) {
    const run = await readRun(io)
    const worker = run ? board.workerOf(run, agentId) : undefined
    if (worker || pendingSpawns === 0) return worker
    await io.sleep(BIND_POLL_MS)
  }
  return undefined
}

export async function serveTool(io: Io, e: ToolCallInput, cwd = ''): Promise<ToolCallResult> {
  const tool = String(e.tool)
  const worker = await workerWithWait(io, e.agentId)
  const control = CONTROL_TOOLS.get(tool)
  if (tool === TOOL.start || control) {
    if (e.agentId !== undefined) return reply({ error: 'NOT_ALLOWED', message: 'Only the main session starts, steers, stops, delivers or discards a meld run, and adds its workers.' })
    const args = e as unknown as Args
    if (!control) return reply(await startFromTool(io, args, cwd))
    return reply({ text: await controlRun(io, control, text(control === 'steer' ? args.text : args.agent)) })
  }
  if (!worker) return reply(tool === TOOL.board ? await overview(io) : { error: 'NOT_WORKER', message: 'The meld tools are for the meld workers.' })
  const now = await io.now()
  if (tool === TOOL.board) return reply(await readBoard(io, worker.id, now))
  const checked = await withResolvedCommit(io, tool, e as unknown as Args, worker)
  let answer: unknown = { error: 'RUN_ENDED', message: 'There is no meld run.' }
  let nudge: Task | undefined
  await save(io, run => {
    if (!run) return run
    const done = answered(run, worker.id, 'error' in checked ? checked : mutate(run, worker.id, tool, checked.args, now, checked.held))
    const passed = board.passContext(done.run, worker.id)
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
function mergeFinished(io: Io, by: WorkerId, id: number): Promise<void> {
  merging = merging.then(() => mergeTask(io, by, id)).catch(() => undefined)
  return merging
}

/** Merges #id when it is a done task that the line lacks, with no task "integrate #id": a finish that leaves its task undone merges nothing. */
async function mergeTask(io: Io, by: WorkerId, id: number): Promise<void> {
  const run = await readRun(io)
  const task = run && ACTIVE_RUN.has(run.state) ? board.unmergedTasks(run).find(one => one.id === id) : undefined
  if (!run || !task) return
  const merged = await vcsFor(run.vcs).mergeIntoLine(io, run, task.commit ?? '', `meld: integrate #${task.id} ${task.title}`)
  const now = await io.now()
  await writeRun(io, current => {
    if (merged.state === 'merged') return board.lineMerged(current, task.id, merged.head, now)
    return runOf(board.addIntegrateTask(current, task.id, integrateDetail(current, task, merged), now), current)
  })
  if (merged.state === 'merged') return
  const after = await readRun(io)
  for (const peer of after?.workers ?? []) if (peer.id !== by && peer.state === 'working') tell(io, peer, wakeText('There is open work on the board.'))
}

/** A tool call of a worker: the worker works, and the call counts. A call can bring a leaf of the worker to its nudge. */
function countedCall(run: Run, by: WorkerId, now: number): { run: Run; task?: Task } {
  return board.takeSplitNudge(board.countCall(board.setWorkerState(run, by, 'working', now), by), by)
}

async function sendNudge(io: Io, by: WorkerId, task: Task | undefined): Promise<void> {
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
function reply(value: unknown): ToolCallResult {
  return { result: JSON.stringify(value) }
}

/**
 * The board keeps the full id of the commit that a revision names in the folder of the worker; a final commit with a
 * conflict is refused. For a final commit, the version control reads which done tasks it holds. A share that gives no
 * commit needs no resolve.
 */
async function withResolvedCommit(io: Io, tool: string, args: Args, worker: Worker): Promise<Checked | Refused> {
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
  return tool === TOOL.finish ? { args: resolved, held: await heldInFinal(io, run, found.commit) } : { args: resolved }
}

/** The commits of the done tasks that `final` holds, as the version control reads them. */
async function heldInFinal(io: Io, run: Run, final: string): Promise<Set<string>> {
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

function mutate(run: Run, by: WorkerId, tool: string, args: Args, now: number, held: ReadonlySet<string> = new Set()): Made {
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
      return withHandBack(board.finishTask(run, by, Number(args.task), Number(args.version), text(args.commit), text(args.summary), now, shared), by)
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
async function readBoard(io: Io, id: WorkerId, now: number): Promise<BoardView | Refused> {
  let view: BoardView | undefined
  let nudge: Task | undefined
  await save(io, run => {
    if (!run) return run
    const seen = board.boardFor(run, id)
    const briefed = seen.run.workers.find(worker => worker.id === id)?.briefed ?? true
    view = briefed ? seen.view : { ...seen.view, rules: workerRules(seen.run, id) }
    const counted = countedCall(briefed ? seen.run : board.markBriefed(seen.run, id), id, now)
    nudge = counted.task
    return counted.run
  })
  await sendNudge(io, id, nudge)
  return view ?? { error: 'RUN_ENDED', message: 'There is no meld run.' }
}

/** What the main session reads of the board: the run as a whole. */
async function overview(io: Io): Promise<unknown> {
  const run = await readRun(io)
  if (!run) return { state: 'none', message: 'There is no meld run. The person starts one with /meld <task>.' }
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
    log: run.log.slice(-10),
  }
}

async function afterChange(io: Io, by: WorkerId, tool: string): Promise<void> {
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

function tell(io: Io, worker: Worker, message: string): void {
  if (worker.agentId) void io.send(worker.agentId, message).catch(() => undefined)
}

/**
 * The run of an idle worker has ended (the engine drops a spawned agent at its hand-back), so meld starts a new agent
 * for that worker, in its folder, with the step in its prompt.
 */
async function restart(io: Io, worker: Worker, step: string): Promise<boolean> {
  const run = await readRun(io)
  if (!run) return false
  pendingSpawns += 1
  try {
    const spawned = await spawnOne(io, run, worker, step)
    const now = await io.now()
    const agentId = spawned.agentId
    if (!agentId) {
      io.toast(`meld: ${worker.id} could not start again: ${spawned.deny ?? 'the engine started no agent'}.`)
      return false
    }
    await writeRun(io, current => board.restartWorker(current, worker.id, agentId, now))
    return true
  } finally {
    pendingSpawns = Math.max(0, pendingSpawns - 1)
  }
}

/** A deny reason for a tool call of a worker, or undefined; records the call as the worker's activity. */
export async function guardCall(io: Io, e: ToolCallInput): Promise<string | undefined> {
  if (e.agentId === undefined) return undefined
  const run = await readRun(io)
  const worker = run ? board.workerOf(run, e.agentId) : undefined
  if (!run || !worker || String(e.tool) === HANDBACK_TOOL) return undefined
  if (worker.state === 'stopped' || run.state === 'stopped') return 'meld stopped you. End your turn now with a one-line summary.'
  if (run.state === 'ready' || run.state === 'delivered') return 'The meld run has its final commit. End your turn now.'
  const path = editedPath(e)
  if (path && !isInside(path, worker.path)) return `meld: you work in ${worker.path}. Edit ${moved(path, run.repo, worker.path)} instead.`
  const now = await io.now()
  let nudge: Task | undefined
  await writeRun(io, current => {
    const counted = countedCall(board.setActivity(current, worker.id, describeCall(e), now), worker.id, now)
    nudge = counted.task
    return counted.run
  })
  await sendNudge(io, worker.id, nudge)
  return undefined
}

function editedPath(e: ToolCallInput): string | undefined {
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

function describeCall(e: ToolCallInput): string {
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

/** The tokens a turn added: its input, the context it wrote to the cache and its output, not the cached context it read again. */
export function freshTokens(usage: TurnUsage | undefined): number {
  if (!usage) return 0
  return usage.input_tokens + usage.cache_creation_input_tokens + usage.output_tokens
}

/**
 * One model call of an agent: its fresh tokens add up on its worker at once. A worker does a task in one long turn, so
 * a count at the end of the turn showed 0 tokens while it worked. The main session and agents that are no worker count nothing.
 */
export async function countStep(io: Io, agentId: string | undefined, usage: TurnUsage | null | undefined): Promise<void> {
  const tokens = freshTokens(usage ?? undefined)
  if (agentId === undefined || !tokens) return
  const run = await readRun(io)
  const worker = run ? board.workerOf(run, agentId) : undefined
  if (!worker) return
  await writeRun(io, current => board.addTokens(current, worker.id, tokens))
}

/** A worker's turn ended: it is idle. Its tokens added up at each model call (countStep). The clock of meld starts workers again (see restartIdleWorkers). */
export async function markWorker(io: Io, agentId: string | undefined, state: WorkerState, tokens = 0): Promise<void> {
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
 * claim, one worker for each such task that no working worker with no claim will take; news on the board that it has not read, for a task of its own; or, with every
 * worker idle, the owners of unfinished tasks, then idle workers for open tasks, else the lead to plan, steer or integrate. Each beat that starts a worker counts; a finished task or a steer resets
 * the count, so after three beats that finish nothing meld stops and tells the person once. One beat runs at a time.
 *
 * Only hooks that no worker needs call it: an agent skips the hook that started it, and an agent that a clock or a
 * button closure starts skips every meld hook, the board and the edit guard included.
 */
export async function restartIdleWorkers(io: Io): Promise<WorkerId[]> {
  if (restarting) return []
  restarting = true
  try {
    await settleEnded(io)
    const run = await readRun(io)
    if (!run || run.state !== 'working' || run.nudges > NUDGE_LIMIT) return []
    const restarts = restartsFor(run)
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

async function settleEnded(io: Io): Promise<void> {
  const run = await readRun(io)
  if (!run || run.state !== 'working') return
  const agents = await io.agents()
  if (!agents) return
  const now = await io.now()
  await writeRun(io, current => board.settleEnded(current, agents, now - LIVENESS_GRACE_MS, now))
}

/**
 * The restarts of one beat. A live worker that is not idle and claims nothing will take an open task: meld started it
 * again for one, or it planned the tasks, and the task stays open until its claim. Such a worker is pending, so the idle
 * workers start for the other open tasks only, and a ready task gets one agent.
 */
function restartsFor(run: Run): Restart[] {
  const live = run.workers.filter(worker => worker.state !== 'stopped')
  const idle = live.filter(worker => worker.state === 'idle')
  const everyoneIdle = idle.length === live.length
  const open = claimable(run.tasks)
  const owners = idle.filter(worker => claimsOf(run, worker).length && (everyoneIdle || hasNews(run, worker)))
  const pending = live.filter(worker => worker.state !== 'idle' && !claimsOf(run, worker).length).length
  const takers = idle.filter(worker => !claimsOf(run, worker).length).slice(0, Math.max(0, open.length - pending))
  const restarts = [
    ...owners.map(worker => ({ worker, step: `Your task is not done: ${titles(claimsOf(run, worker))}. Go on with it, or release it with a note.` })),
    ...takers.map(worker => ({ worker, step: `These tasks are open: ${titles(open)}. Claim one and do it.` })),
  ]
  if (restarts.length || !everyoneIdle) return restarts
  const lead = live.find(worker => worker.id === run.integrator) ?? live[0]
  return lead ? [{ worker: lead, step: leadStep(run, lead) }] : []
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

export async function steerRun(io: Io, instruction: string): Promise<string> {
  if (!instruction) return 'Write the instruction after /meld-steer.'
  const line = await lineToFinal(io)
  if ('error' in line) return line.error
  const now = await io.now()
  let outcome = 'There is no run to steer.'
  let revision = 0
  await save(io, run => {
    if (!run) return run
    const change = board.steer(run, instruction, now, line.moved)
    if (board.isFailure(change)) {
      outcome = change.message
      return run
    }
    revision = change.value
    return change.run
  })
  if (!revision) return outcome
  await settleEnded(io)
  const run = await readRun(io)
  if (!run) return outcome
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

/**
 * Before a steer of a ready run, meld moves the integration line to the final commit, so that the steer keeps the work of
 * that commit: the merges after the steer and the next final build on it. The move runs in the chain of merges, as it
 * moves the line too. It gives the commit that the line moved to, nothing for a run that is not ready, or why the line
 * could not move: then the steer changes nothing.
 */
function lineToFinal(io: Io): Promise<{ moved?: string } | { error: string }> {
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

export async function stopAll(io: Io): Promise<string> {
  const now = await io.now()
  const run = await writeRun(io, current => board.stopRun(current, now))
  if (!run) return 'There is no run.'
  for (const worker of run.workers) tell(io, worker, 'meld stopped the run. End your turn now.')
  return 'Stopped. The workspaces stay until you discard them with /meld-discard or in the meld pane.'
}

export async function stopOne(io: Io, id: WorkerId): Promise<string> {
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
export function controlRun(io: Io, control: Control, input = ''): Promise<string> {
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
export async function addWorker(io: Io, agentText: string): Promise<string> {
  const run = await readRun(io)
  if (!run || !ACTIVE_RUN.has(run.state)) return NO_RUN_AT_WORK
  if (run.workers.length >= MAX_AGENTS) return `A run has ${MAX_AGENTS} workers at most.`
  const id = nextWorkerId(run)
  const made = await vcsFor(run.vcs).addWorkspace(io, run, id)
  if ('error' in made) return `meld could not make the workspace of ${id}: ${made.error}`
  const agent = agentText ? agentSpecOf(agentText) : (run.workers[0]?.agent ?? { type: WORKER_TYPE })
  const now = await io.now()
  const joined = await writeRun(io, current => board.addWorker(current, { id, agent, path: made.path, ref: made.ref }, now))
  const worker = joined?.workers.find(one => one.id === id)
  if (!joined || !worker) return NO_RUN_AT_WORK
  const refused = await spawnWorkers(io, joined, [worker])
  if (refused.length) return `${id} joined the run, but its agent did not start: ${refused[0]}.`
  return `${id} joined the run. Its workspace is ${made.path}, from ${run.line ? 'the integration line' : 'the base'}.`
}

function nextWorkerId(run: Run): WorkerId {
  return `w${Math.max(0, ...run.workers.map(worker => Number(worker.id.slice(1)))) + 1}`
}

/**
 * Merges the final commit into the branch of the person. The run is delivered before meld removes its folder, as meld
 * mirrors no delivered run: a worker that ends its turn during the removal does not make the folder again.
 */
export async function deliver(io: Io): Promise<string> {
  const run = await readRun(io)
  if (!run || run.state !== 'ready' || !run.final) return 'There is no final commit to deliver.'
  const missing = lackingWork(run, await heldInFinal(io, run, run.final.commit))
  if (missing.length) return lackingDelivery(run.final.commit, missing)
  if (await isDirty(io, run.repo)) return 'Commit or stash the changes in your checkout first, then deliver.'
  const vcs = vcsFor(run.vcs)
  const merged = await vcs.deliver(io, run, run.final.commit, deliveryMessage(run))
  if (!merged.ok) return `The merge stopped, and nothing changed: ${merged.err || merged.out}`
  const now = await io.now()
  await writeRun(io, current => board.markDelivered(current, now))
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

export async function discard(io: Io): Promise<string> {
  const run = await readRun(io)
  if (!run) return 'There is no run.'
  if (LIVE_STATES.has(run.state)) await stopAll(io)
  await dropRun(io, run)
  return 'The run and its workspaces are gone.'
}

/**
 * Drops the run and its facts, then removes the workspaces of a run that meld did not deliver. The run goes first: a
 * worker that ends its turn during the removal then writes no run, so no mirror of the board makes its folder again.
 */
async function dropRun(io: Io, run: Run): Promise<void> {
  await save(io, () => null)
  await io.writeFacts(null)
  if (run.state !== 'delivered') await vcsFor(run.vcs).remove(io, run)
}

/** Reads what the version control shows of the run, for the pane: the commits of each worker, and the change of the final commit. */
export async function refreshFacts(io: Io): Promise<void> {
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
