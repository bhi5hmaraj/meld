import type { CommandRunResult, ToolCallInput, ToolCallResult } from 'claude-code'

import type { BoardView, Change, NewTask, Run, Worker, WorkerId, WorkerState } from '../types'
import * as board from './board'
import { launchPrompt, TOOL, wakeText, workerRules } from './contract'
import * as git from './git'
import type { Io } from './io'

const WORKTREES = '/tmp/meld'
const WORKER_IDS: WorkerId[] = ['w1', 'w2']
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const COMMIT_TOOLS = new Set<string>([TOOL.finishTask, TOOL.check, TOOL.finish])
const OPEN_WORK_TOOLS = new Set<string>([TOOL.addTasks, TOOL.release])
const LIVE_STATES = new Set(['starting', 'working', 'ready'])
const BIND_POLL_MS = 200
const BIND_POLLS = 100
const NUDGE_LIMIT = 3

type Args = Record<string, unknown>

let launches = 0
let pendingBinds = 0

export async function readRun(io: Io): Promise<Run | null> {
  return (await io.read()) ?? null
}

async function writeRun(io: Io, change: (run: Run) => Run): Promise<Run | null> {
  let written: Run | null = null
  await io.write(run => {
    written = run ? change(run) : null
    return written
  })
  return written
}

export async function startRun(io: Io, cwd: string, request: string): Promise<CommandRunResult> {
  if (!request) return { text: 'meld: write the task after /meld.' }
  const current = await readRun(io)
  if (current && LIVE_STATES.has(current.state)) {
    return { text: 'meld: a run is active. Deliver, discard or stop it in the meld pane first.' }
  }
  const named = await namedRepo(io, request)
  const repo = named?.repo ?? (await git.repoRoot(io, cwd))
  if (!repo) return { text: 'meld needs a git repository in the working directory.' }
  const task = named?.task ?? request
  const base = await git.headCommit(io, repo)
  const now = await io.now()
  const id = now.toString(36)
  const workers = WORKER_IDS.map(name => ({ path: `${WORKTREES}/${id}/${name}`, branch: `meld/${id}/${name}` }))
  const failed = await makeWorktrees(io, repo, base, workers)
  if (failed) return { text: `meld could not make a worktree: ${failed}` }
  const run = board.startRun({ id, request: task, repo, base, now, workers })
  await io.write(() => run)
  launches = 0
  pendingBinds = 0
  void io.openPane(false)
  void io.submit(launchPrompt(run))
  const dirty = (await git.isDirty(io, repo)) ? ' Your uncommitted changes are not in their worktrees.' : ''
  return { text: `meld: run ${id} starts two workers from commit ${base.slice(0, 7)}.${dirty}`, context: [workerRules(run)] }
}

/** `/meld /path/to/repo task` works in that repository; a first word that names no repository is part of the task. */
async function namedRepo(io: Io, request: string): Promise<{ repo: string; task: string } | undefined> {
  const [first = '', ...rest] = request.split(/\s+/)
  if (!first.startsWith('/') || rest.length === 0) return undefined
  const repo = await git.repoRoot(io, first)
  return repo ? { repo, task: request.slice(first.length).trim() } : undefined
}

async function makeWorktrees(io: Io, repo: string, base: string, workers: { path: string; branch: string }[]): Promise<string | undefined> {
  for (const [index, worker] of workers.entries()) {
    const added = await git.addWorktree(io, repo, worker.path, worker.branch, base)
    if (added.ok) continue
    for (const made of workers.slice(0, index)) await git.removeWorktree(io, repo, made.path, made.branch)
    return added.err || added.out
  }
  return undefined
}

/** The worker a fork of the main loop becomes while a run starts; undefined for any other spawn. */
export async function claimSlot(io: Io, isFork: boolean, parentAgentId: string | undefined): Promise<Worker | undefined> {
  const run = await readRun(io)
  if (!run || run.state !== 'starting' || !isFork || parentAgentId !== undefined || launches >= WORKER_IDS.length) return undefined
  const worker = run.workers[launches]
  launches += 1
  pendingBinds += 1
  return worker
}

export async function bindAgent(io: Io, id: WorkerId, agentId: string | undefined): Promise<void> {
  pendingBinds = Math.max(0, pendingBinds - 1)
  if (!agentId) return
  const now = await io.now()
  await writeRun(io, run => runOf(board.bindWorker(run, id, agentId, now), run))
}

function runOf<T>(change: Change<T>, fallback: Run): Run {
  return board.isFailure(change) ? fallback : change.run
}

/** A fork can call a tool before its spawn returns its id: wait for the binding while one is pending. */
async function workerWithWait(io: Io, agentId: string | undefined): Promise<Worker | undefined> {
  if (agentId === undefined) return undefined
  for (let poll = 0; poll < BIND_POLLS; poll++) {
    const run = await readRun(io)
    const worker = run ? board.workerOf(run, agentId) : undefined
    if (worker || pendingBinds === 0) return worker
    await io.sleep(BIND_POLL_MS)
  }
  return undefined
}

export async function serveTool(io: Io, e: ToolCallInput): Promise<ToolCallResult> {
  const tool = String(e.tool)
  const args = e as unknown as Args
  const worker = await workerWithWait(io, e.agentId)
  if (!worker) return reply(tool === TOOL.board ? await overview(io) : { error: 'NOT_WORKER', message: 'The meld tools are for the two meld workers.' })
  if (tool === TOOL.board) return reply(await readBoard(io, worker.id))
  const missing = await missingCommit(io, tool, args)
  if (missing) return reply(missing)
  const now = await io.now()
  let answer: unknown = { error: 'RUN_ENDED', message: 'There is no meld run.' }
  await io.write(run => {
    if (!run) return run
    const change = mutate(run, worker.id, tool, args, now)
    if (board.isFailure(change)) {
      answer = change
      return run
    }
    const taken = board.takeNotice(change.run, worker.id)
    answer = { ok: true, value: change.value, notice: taken.notice }
    return taken.run
  })
  await afterChange(io, worker.id, tool)
  return reply(answer)
}

/** A plugin tool answers the model with text: the JSON of the value. */
function reply(value: unknown): ToolCallResult {
  return { result: JSON.stringify(value) }
}

function mutate(run: Run, by: WorkerId, tool: string, args: Args, now: number): Change<unknown> {
  switch (tool) {
    case TOOL.addTasks:
      return board.addTasks(run, by, { seen: Number(args.seen), tasks: newTasks(args.tasks) }, now)
    case TOOL.claim:
      return board.claimTask(run, by, Number(args.task), Number(args.version), now)
    case TOOL.release:
      return board.releaseTask(run, by, Number(args.task), Number(args.version), text(args.note), now)
    case TOOL.finishTask:
      return board.finishTask(run, by, Number(args.task), Number(args.version), text(args.commit), text(args.summary), now)
    case TOOL.note:
      return board.addNote(run, by, text(args.text), args.commit === undefined ? undefined : text(args.commit), now)
    case TOOL.check:
      return board.addCheck(run, by, { command: text(args.command), commit: text(args.commit), passed: args.passed === true, output: text(args.output) }, now)
    case TOOL.integrate:
      return board.takeIntegration(run, by, now)
    case TOOL.finish:
      return board.declareFinal(run, by, text(args.commit), text(args.summary), now)
    default:
      return { error: 'NOT_FOUND', message: `meld has no tool ${tool}.` }
  }
}

function newTasks(value: unknown): NewTask[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isRecord)
    .map(task => ({ title: text(task.title), detail: task.detail === undefined ? undefined : text(task.detail) }))
    .filter(task => task.title)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined ? '' : String(value)
}

async function missingCommit(io: Io, tool: string, args: Args): Promise<{ error: string; message: string } | undefined> {
  if (!COMMIT_TOOLS.has(tool)) return undefined
  const run = await readRun(io)
  const commit = text(args.commit)
  if (!run || (commit && (await git.commitExists(io, run.repo, commit)))) return undefined
  return { error: 'NOT_FOUND', message: `There is no commit "${commit}". Commit your work on your branch, then use its hash.` }
}

async function readBoard(io: Io, id: WorkerId): Promise<BoardView | { error: string; message: string }> {
  let view: BoardView | undefined
  await io.write(run => {
    if (!run) return run
    const seen = board.boardFor(run, id)
    view = seen.view
    return seen.run
  })
  return view ?? { error: 'RUN_ENDED', message: 'There is no meld run.' }
}

async function overview(io: Io): Promise<unknown> {
  const run = await readRun(io)
  if (!run) return { state: 'none', message: 'There is no meld run. The person starts one with /meld <task>.' }
  return {
    id: run.id,
    state: run.state,
    request: run.request,
    steers: board.steersOf(run),
    workers: run.workers.map(worker => ({ id: worker.id, state: worker.state, activity: worker.activity, branch: worker.branch, path: worker.path })),
    tasks: run.tasks,
    final: run.final,
  }
}

async function afterChange(io: Io, by: WorkerId, tool: string): Promise<void> {
  const run = await readRun(io)
  const peer = run?.workers.find(worker => worker.id !== by)
  if (!run || !peer) return
  if (OPEN_WORK_TOOLS.has(tool) && peer.state === 'idle') tell(io, peer, wakeText('There is open work on the board.'))
  if (tool === TOOL.finish && run.state === 'ready') {
    if (peer.state !== 'stopped') tell(io, peer, 'meld: the final commit is declared. End your turn now.')
    io.toast('meld: the result is ready. Deliver it from the meld pane.')
  }
}

function tell(io: Io, worker: Worker, message: string): void {
  if (worker.agentId) void io.send(worker.agentId, message).catch(() => undefined)
}

/** A deny reason for a tool call of a worker, or undefined; records the call as the worker's activity. */
export async function guardCall(io: Io, e: ToolCallInput): Promise<string | undefined> {
  if (e.agentId === undefined) return undefined
  const run = await readRun(io)
  const worker = run ? board.workerOf(run, e.agentId) : undefined
  if (!run || !worker) return undefined
  if (worker.state === 'stopped' || run.state === 'stopped') return 'meld stopped you. End your turn now with a one-line summary.'
  if (run.state === 'ready' || run.state === 'delivered') return 'The meld run has its final commit. End your turn now.'
  const path = editedPath(e)
  if (path && !isInside(path, worker.path)) return `meld: you work in ${worker.path}. Edit ${moved(path, run.repo, worker.path)} instead.`
  const now = await io.now()
  await writeRun(io, current => board.setActivity(current, worker.id, describeCall(e), now))
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
  if (tool === 'Bash') return `Bash: ${text(args.command).slice(0, 60)}`
  const path = text(args.file_path ?? args.notebook_path ?? args.path ?? args.pattern)
  return path ? `${tool} ${path.split('/').pop()}` : tool
}

export async function markWorker(io: Io, agentId: string | undefined, state: WorkerState): Promise<void> {
  if (agentId === undefined) return
  const run = await readRun(io)
  const worker = run ? board.workerOf(run, agentId) : undefined
  if (!run || !worker) return
  const now = await io.now()
  await writeRun(io, current => board.setWorkerState(current, worker.id, state, now))
  if (state === 'idle') await nudgeIfStuck(io)
}

/** Both live workers idle with no final commit: wake one with the next step, a few times at most. */
async function nudgeIfStuck(io: Io): Promise<void> {
  const run = await readRun(io)
  if (!run || run.state !== 'working') return
  const live = run.workers.filter(worker => worker.state !== 'stopped')
  if (!live.length || live.some(worker => worker.state !== 'idle')) return
  if (run.nudges >= NUDGE_LIMIT) {
    io.toast('meld: both workers are idle. Steer them or stop the run.')
    return
  }
  await writeRun(io, board.countNudge)
  const unfinished = run.tasks.filter(task => task.state !== 'done').map(task => `#${task.id} ${task.title}`)
  const integrator = live.find(worker => worker.id === run.integrator) ?? live[0]
  if (!integrator) return
  const step = unfinished.length
    ? `Both workers are idle, and these tasks are not done: ${unfinished.join('; ')}. Do them, or release the ones you cannot do with a note.`
    : `All tasks are done. Integrate: call ${TOOL.integrate}, merge both branches into yours, run the checks, then call ${TOOL.finish}.`
  tell(io, integrator, wakeText(step))
}

export async function steerRun(io: Io, instruction: string): Promise<string> {
  if (!instruction) return 'meld: write the instruction after /meld-steer.'
  const now = await io.now()
  let outcome = 'meld: there is no run to steer.'
  let revision = 0
  await io.write(run => {
    if (!run) return run
    const change = board.steer(run, instruction, now)
    if (board.isFailure(change)) {
      outcome = `meld: ${change.message}`
      return run
    }
    revision = change.value
    outcome = `meld: both workers get revision ${revision}.`
    return change.run
  })
  const run = await readRun(io)
  if (revision && run) {
    for (const worker of run.workers) {
      if (worker.state !== 'stopped') tell(io, worker, wakeText(`The person changed the request (revision ${revision}): ${instruction}`))
    }
  }
  return outcome
}

export async function stopAll(io: Io): Promise<string> {
  const now = await io.now()
  const run = await writeRun(io, current => board.stopRun(current, now))
  if (!run) return 'meld: there is no run.'
  for (const worker of run.workers) tell(io, worker, 'meld stopped the run. End your turn now.')
  return 'meld: stopped. The worktrees and branches stay until you discard them in the meld pane.'
}

export async function stopOne(io: Io, id: WorkerId): Promise<string> {
  const now = await io.now()
  const run = await writeRun(io, current => board.stopWorker(current, id, now))
  const worker = run?.workers.find(one => one.id === id)
  const peer = run?.workers.find(one => one.id !== id)
  if (!run || !worker) return 'meld: there is no run.'
  tell(io, worker, 'meld stopped you. End your turn now.')
  if (peer && peer.state !== 'stopped') tell(io, peer, wakeText(`The person stopped ${id}. Its claimed tasks are open again, and you finish the run.`))
  return `meld: stopped ${id}.`
}

export async function deliver(io: Io): Promise<string> {
  const run = await readRun(io)
  if (!run || run.state !== 'ready' || !run.final) return 'meld: there is no final commit to deliver.'
  if (await git.isDirty(io, run.repo)) return 'meld: commit or stash the changes in your checkout first, then deliver.'
  const merged = await git.mergeInto(io, run.repo, run.final.commit, `meld: ${run.request.split('\n')[0]?.slice(0, 72)}`)
  if (!merged.ok) return `meld: the merge stopped, and nothing changed: ${merged.err || merged.out}`
  await removeWorktrees(io, run)
  const now = await io.now()
  await writeRun(io, current => board.markDelivered(current, now))
  return `meld: merged ${run.final.commit.slice(0, 7)} into your branch.`
}

export async function discard(io: Io): Promise<string> {
  const run = await readRun(io)
  if (!run) return 'meld: there is no run.'
  if (LIVE_STATES.has(run.state)) await stopAll(io)
  await removeWorktrees(io, run)
  await io.write(() => null)
  return 'meld: the run, its worktrees and its branches are gone.'
}

async function removeWorktrees(io: Io, run: Run): Promise<void> {
  for (const worker of run.workers) await git.removeWorktree(io, run.repo, worker.path, worker.branch)
}
