import type { CommandRunResult, ToolCallInput, ToolCallResult, TurnUsage } from 'claude-code'

import type { BoardView, Change, Facts, NewTask, PaneView, Run, Task, VcsKind, Worker, WorkerId, WorkerState } from '../types'
import * as board from './board'
import { TOOL, wakeText, workerPrompt, workerRules } from './contract'
import { headCommit, isDirty, repoRoot } from './git'
import type { Io, Spawned } from './io'
import { agentsOf, parseStart } from './options'
import type { StartOptions } from './options'
import { detectVcs, vcsFor } from './vcs'
import type { Prepared } from './vcs'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** The tool that ends the run of an agent that meld starts: the guard never refuses it, or the agent cannot end. */
const HANDBACK_TOOL = 'SubagentHandback'
const COMMIT_TOOLS = new Set<string>([TOOL.finishTask, TOOL.check, TOOL.finish])
const OPEN_WORK_TOOLS = new Set<string>([TOOL.addTasks, TOOL.release])
const LIVE_STATES = new Set(['starting', 'working', 'ready'])
const BIND_POLL_MS = 200
const BIND_POLLS = 100
const NUDGE_LIMIT = 3
const STUCK_TOAST = 'meld: three restarts in a row finished no task. Steer the workers or stop the run.'
const LIVENESS_GRACE_MS = 15_000
const JJ_MISSING = 'jj 0.40 or newer is not installed. Use --vcs git or --vcs auto.'
export const LEADING_CD = /^(?:\s*cd\s+\S+\s*(?:&&|;)\s*)+/

type Args = Record<string, unknown>
type Refused = { error: string; message: string }

let pendingSpawns = 0
let restarting = false

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

export async function startRun(io: Io, cwd: string, options: StartOptions): Promise<CommandRunResult> {
  const current = await readRun(io)
  if (current && LIVE_STATES.has(current.state)) return { text: 'A run is active. Deliver, discard or stop it in the meld pane first.' }
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
  await io.write(() => run)
  await io.writeFacts(null)
  void io.openPane(false)
  const refused = await spawnWorkers(io, run)
  if (refused.length === workers.length) return { text: `No worker started: ${refused[0]}.${fallback}` }
  const notStarted = refused.length ? ` ${refused.length} did not start: ${refused[0]}.` : ''
  const dirty = (await isDirty(io, repo)) ? ' Your uncommitted changes are not in their workspaces.' : ''
  return { text: `Run ${id}: ${workers.length} workers on ${kind}, from commit ${base.slice(0, 7)}.${fallback}${notStarted}${dirty}` }
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
async function spawnWorkers(io: Io, run: Run): Promise<string[]> {
  const refused: string[] = []
  for (const worker of run.workers) {
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
      prompt: step ? `${workerPrompt(run, worker.id)}\n\nWhat meld asks of you now: ${step}` : workerPrompt(run, worker.id),
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
  if (tool === TOOL.start || tool === TOOL.stop || tool === TOOL.steer) {
    if (e.agentId !== undefined) return reply({ error: 'NOT_ALLOWED', message: 'Only the main session starts, steers or stops a meld run.' })
    if (tool === TOOL.start) return reply(await startFromTool(io, e as unknown as Args, cwd))
    return reply({ text: tool === TOOL.stop ? await stopAll(io) : await steerRun(io, text((e as unknown as Args).text).trim()) })
  }
  if (!worker) return reply(tool === TOOL.board ? await overview(io) : { error: 'NOT_WORKER', message: 'The meld tools are for the meld workers.' })
  const now = await io.now()
  if (tool === TOOL.board) return reply(await readBoard(io, worker.id, now))
  const checked = await withResolvedCommit(io, tool, e as unknown as Args, worker)
  if ('error' in checked) return reply(checked)
  let answer: unknown = { error: 'RUN_ENDED', message: 'There is no meld run.' }
  await io.write(run => {
    if (!run) return run
    const change = mutate(run, worker.id, tool, checked.args, now)
    if (board.isFailure(change)) {
      answer = change
      return board.countCall(board.setWorkerState(run, worker.id, 'working', now), worker.id)
    }
    const taken = board.takeNotice(change.run, worker.id)
    answer = { ok: true, value: change.value, notice: taken.notice }
    return board.countCall(board.setWorkerState(taken.run, worker.id, 'working', now), worker.id)
  })
  await afterChange(io, worker.id, tool)
  return reply(answer)
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

/** The board keeps the full id of the commit that a revision names in the folder of the worker; a final commit with a conflict is refused. */
async function withResolvedCommit(io: Io, tool: string, args: Args, worker: Worker): Promise<{ args: Args } | Refused> {
  if (!COMMIT_TOOLS.has(tool)) return { args }
  const run = await readRun(io)
  if (!run) return { args }
  const vcs = vcsFor(run.vcs)
  const revision = text(args.commit)
  const found = revision ? await vcs.resolve(io, run, worker, revision) : undefined
  if (!found) return { error: 'NOT_FOUND', message: `There is no commit "${revision}" in your folder. ${vcs.commitHint}` }
  if (tool === TOOL.finish && found.conflict) {
    return { error: 'CONFLICT', message: `${found.commit.slice(0, 12)} has a conflict. Fix the conflict, commit, and finish with the new commit.` }
  }
  return { args: { ...args, commit: found.commit } }
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

/** The board of a worker; its first read also carries its rules, for an agent of any type. */
async function readBoard(io: Io, id: WorkerId, now: number): Promise<BoardView | Refused> {
  let view: BoardView | undefined
  await io.write(run => {
    if (!run) return run
    const seen = board.boardFor(run, id)
    const briefed = seen.run.workers.find(worker => worker.id === id)?.briefed ?? true
    view = briefed ? seen.view : { ...seen.view, rules: workerRules(seen.run, id) }
    return board.countCall(board.setWorkerState(briefed ? seen.run : board.markBriefed(seen.run, id), id, 'working', now), id)
  })
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
    io.toast('meld: the result is ready. Deliver it from the meld pane.')
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
  await writeRun(io, current => board.countCall(board.setWorkerState(board.setActivity(current, worker.id, describeCall(e), now), worker.id, 'working', now), worker.id))
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

/** The tokens a turn added: its input, the context it wrote to the cache and its output, not the cached context it read again. */
/** What the person reads when meld asks to start a worker. */
export const SPAWN_ASK = 'meld starts a worker of the run that you started.'

/**
 * The verdict on an Agent call. Auto mode's classifier allows a call that it links to the person's request. A spawn that
 * a plugin makes carries no request, so the classifier gives no verdict and the spawn fails. An ask that a hook answers
 * goes to the person, so meld answers the ask on its own spawn while its run lives. Every other verdict stands: a deny
 * from a rule, the ceiling of the organization, and each call that meld did not raise.
 */
export function spawnVerdict<V extends { decision: string }>(verdict: V, plugin: string, run: Run | null): V | { decision: 'ask'; reason: string } {
  if (verdict.decision !== 'ask' || plugin !== 'meld' || !run || !LIVE_STATES.has(run.state)) return verdict
  return { decision: 'ask', reason: SPAWN_ASK }
}

export function freshTokens(usage: TurnUsage | undefined): number {
  if (!usage) return 0
  return usage.input_tokens + usage.cache_creation_input_tokens + usage.output_tokens
}

/** A worker's turn ended: it is idle and its tokens add up. The clock of meld starts workers again (see restartIdleWorkers). */
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
 * One beat of the clock. The run of an idle worker has ended (the engine drops a spawned agent at its hand-back), so
 * meld starts a new agent for it when there is work for it: news on the board that it has not read, with an open task
 * or a task of its own; or, with every worker idle, the owners of unfinished tasks, then idle workers for open tasks,
 * else the lead to plan, steer or integrate. Each beat that starts a worker counts; a finished task or a steer resets
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

function restartsFor(run: Run): Restart[] {
  const live = run.workers.filter(worker => worker.state !== 'stopped')
  const idle = live.filter(worker => worker.state === 'idle')
  const everyoneIdle = idle.length === live.length
  const ready = everyoneIdle ? idle : idle.filter(worker => hasNews(run, worker))
  const open = run.tasks.filter(task => task.state === 'open')
  const owners = ready.filter(worker => claimsOf(run, worker).length)
  const takers = ready.filter(worker => !claimsOf(run, worker).length).slice(0, open.length)
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
  return `All tasks are done. Integrate: call ${TOOL.integrate}, merge the work of every worker into yours, run the checks, then call ${TOOL.finish}.`
}

export async function steerRun(io: Io, instruction: string): Promise<string> {
  if (!instruction) return 'Write the instruction after /meld-steer.'
  const now = await io.now()
  let outcome = 'There is no run to steer.'
  let revision = 0
  await io.write(run => {
    if (!run) return run
    const change = board.steer(run, instruction, now)
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
  if (running.length === live.length) return `All ${live.length} workers get revision ${revision}.`
  if (running.length) return `Revision ${revision}: ${running.length} running workers get it; the others see it when meld starts them again.`
  if (!live.length) return `Revision ${revision}: no worker is left to take it.`
  const started = await restartIdleWorkers(io)
  if (!started.length) return `Revision ${revision}: every worker has ended, and meld could not start one again.`
  return `Revision ${revision}: meld starts ${started.join(', ')} again with it.`
}

export async function stopAll(io: Io): Promise<string> {
  const now = await io.now()
  const run = await writeRun(io, current => board.stopRun(current, now))
  if (!run) return 'There is no run.'
  for (const worker of run.workers) tell(io, worker, 'meld stopped the run. End your turn now.')
  return 'Stopped. The workspaces stay until you discard them in the meld pane.'
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

export async function deliver(io: Io): Promise<string> {
  const run = await readRun(io)
  if (!run || run.state !== 'ready' || !run.final) return 'There is no final commit to deliver.'
  if (await isDirty(io, run.repo)) return 'Commit or stash the changes in your checkout first, then deliver.'
  const vcs = vcsFor(run.vcs)
  const merged = await vcs.deliver(io, run, run.final.commit, `meld: ${run.request.split('\n')[0]?.slice(0, 72)}`)
  if (!merged.ok) return `The merge stopped, and nothing changed: ${merged.err || merged.out}`
  await vcs.remove(io, run)
  const now = await io.now()
  await writeRun(io, current => board.markDelivered(current, now))
  return `Merged ${run.final.commit.slice(0, 7)} into your branch.`
}

export async function discard(io: Io): Promise<string> {
  const run = await readRun(io)
  if (!run) return 'There is no run.'
  if (LIVE_STATES.has(run.state)) await stopAll(io)
  if (run.state !== 'delivered') await vcsFor(run.vcs).remove(io, run)
  await io.write(() => null)
  await io.writeFacts(null)
  return 'The run and its workspaces are gone.'
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
