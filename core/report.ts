import type { ContextEntry, Entry, Run, Task } from '../types'
import { command } from './git'
import { collaborationOf, efficiencyOf, lanesOf, progressOf, sharedContextOf, workloadOf } from './metrics'
import type { LaneKind, LanePart } from './metrics'
import type { Archive, Clock, CodeHost, Files, Store } from './ports'
import { SAFE_ID } from './vcs'

/** A span of time, as a Flow window or a sleep of the machine. */
export type TimeSpan = { from: number; to: number }

/** The shape of each kind of part of a lane in text cells, so each kind reads with no colour. */
export const FLOW_SHAPE: Record<LaneKind, string> = { working: '█', merging: '◆', waiting: '▒', idle: '·', asleep: 'z' }
export const FLOW_CELLS = 30
export const PART_WORDS: Record<LaneKind, string> = { working: 'working', merging: 'merging', waiting: 'waiting on meld', idle: 'idle', asleep: 'asleep' }
const TASK_WORDS: Partial<Record<LaneKind, string>> = { working: ' on #', merging: ' #' }
export const FLOW_LEGEND = (Object.keys(FLOW_SHAPE) as LaneKind[]).map(kind => `${FLOW_SHAPE[kind]} ${PART_WORDS[kind]}`).join('  ')
/** The newest archived runs that the table of runs shows. */
const RUNS_SHOWN = 20
const NO_RUN = 'There is no meld run in this session. Give the id of an archived run, or --runs.'
const RUNS_HEADER = '| Run | Agents | Tasks | Time | Busy | One agent alone | Ready with no agent | Balance | Cited | Rework | Cache reads | Per task |\n|---|---|---|---|---|---|---|---|---|---|---|---|'

/** The record of a run in the archive, as archiveRun of core/actions.ts writes it. */
type ArchiveRecord = { run: Omit<Run, 'request' | 'tasks' | 'log' | 'context'>; board: { request: string; tasks: Task[] }; events: Entry[]; context: ContextEntry[] }

/** The parts of a lane inside the window, cut at its edges. */
export function partsIn(parts: readonly LanePart[], window: TimeSpan): LanePart[] {
  return parts.flatMap(part => {
    const from = Math.max(part.from, window.from)
    const to = Math.min(part.to, window.to)
    return to > from ? [{ ...part, from, to }] : []
  })
}

export function partWords(part: LanePart): string {
  if (part.kind === 'idle' && part.reason === 'background') return 'waiting for its background work'
  const join = TASK_WORDS[part.kind]
  const task = join && part.task !== undefined ? `${join}${part.task}` : ''
  const reason = part.kind === 'waiting' && part.reason ? `: ${part.reason}` : ''
  return `${PART_WORDS[part.kind]}${task}${reason}`
}

/**
 * A lane in text cells over the window: each cell shows the kind that covers the most of its time. The sleeps of the
 * machine cover every lane, and a cell outside the worker time is a space.
 */
export function flowCells(parts: readonly LanePart[], sleeps: readonly TimeSpan[], window: TimeSpan, cells: number): string {
  const size = (window.to - window.from) / cells
  const covers = [...parts.filter(part => part.kind !== 'asleep'), ...sleeps.map(span => ({ ...span, kind: 'asleep' as const }))]
  return Array.from({ length: cells }, (_, index) => {
    const from = window.from + index * size
    const to = from + size
    const ms = new Map<LaneKind, number>()
    for (const part of covers) {
      const overlap = Math.min(to, part.to) - Math.max(from, part.from)
      if (overlap > 0) ms.set(part.kind, (ms.get(part.kind) ?? 0) + overlap)
    }
    const top = [...ms].reduce<[LaneKind, number] | undefined>((best, one) => (!best || one[1] > best[1] ? one : best), undefined)
    return top ? FLOW_SHAPE[top[0]] : ' '
  }).join('')
}

export function sleepsOf(run: Run): TimeSpan[] {
  return run.log.filter(entry => entry.kind === 'host').map(entry => ({ from: entry.from ?? entry.at, to: entry.at }))
}

/**
 * The report of section 3.5 of docs/design/pane-metrics-logs.md: a story in five sentences, the time, progress and cost
 * of the run, how the agents worked together, and one line for each worker.
 */
export type Report = { story: string; run: string[]; team: string[]; workers: string[] }

const MINUTE = 60_000

function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`
}

function minutes(ms: number): string {
  return `${Math.round(ms / MINUTE)}m`
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`
}

export function tokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(Math.round(tokens))
}

/** The report fills fixed templates with the metrics of section 4, so it makes no model call and reads the same on every surface. */
export function reportOf(run: Run, now: number, events: readonly Entry[] = run.log): Report {
  const efficiency = efficiencyOf(run, now, events)
  const progress = progressOf(run, now, events)
  const together = collaborationOf(run, now, events)
  const context = sharedContextOf(run, now, events)
  const workload = workloadOf(run, now, events)
  const top = workload.shares.reduce<(typeof workload.shares)[number] | undefined>((best, one) => (!best || one.share > best.share ? one : best), undefined)
  const story = [
    `${plural(run.workers.length, 'agent')} finished ${plural(progress.done, 'task')} in ${plural(Math.round(efficiency.runMs / MINUTE), 'minute')}.`,
    `For ${Math.round(efficiency.aloneMs / MINUTE)} of those minutes, only one agent worked.`,
    progress.done && top ? `${top.worker} did ${percent(top.share)} of the work.` : 'No agent finished a task.',
    context.all ? `${context.delivered} of ${context.all} entries reached another agent.` : 'No agent shared an entry.',
    `${efficiency.checks ? `${efficiency.failedChecks} of ${plural(efficiency.checks, 'check')} failed` : 'No check ran'}, and the person ${together.steers ? `steered ${plural(together.steers, 'time')}` : 'did not steer'}.`,
  ].join(' ')
  const all = progress.done + progress.working + progress.ready + progress.waiting
  const mix = workload.agentMix.map(kind => `${kind.type} did ${percent(kind.share)} of the work with rework ${kind.rework.toFixed(2)}`).join('; ')
  return {
    story,
    run: [
      `Time: ${minutes(efficiency.runMs)} of run, ${minutes(efficiency.workerMs)} of agent time, busy ${percent(efficiency.busyShare)}, parallelism ${efficiency.parallelism.toFixed(1)}, one agent alone ${minutes(efficiency.aloneMs)}, waiting on meld ${minutes(efficiency.waitingMs)}, asleep ${minutes(efficiency.asleepMs)}, idle restarts ${efficiency.idleRestarts}.`,
      `Progress: ${progress.done} of ${plural(all, 'task')} done, weight ${progress.doneWeight} of ${progress.allWeight}, ready with no agent ${minutes(progress.readyNoAgent.ms)}, scope growth ${progress.scopeGrowth.toFixed(2)}, critical path left ${plural(progress.criticalPath.tasks, 'task')}, ${progress.blocked.count} blocked, task time ${minutes(progress.taskMs)}.`,
      `Cost: ${tokenCount(efficiency.costUnits)} tokens, ${tokenCount(efficiency.costPerTask)} for each finished task, cache reads ${percent(efficiency.cacheReadShare)} of the cost, rework ${efficiency.rework.toFixed(2)} for each task, ${efficiency.failedChecks} of ${plural(efficiency.checks, 'check')} failed.`,
    ],
    team: [
      `Together: cross needs ${together.crossNeeds} of ${together.withNeeds}, handovers used ${together.handoversUsed}, commits taken ${together.commitsTaken}, splits for others ${together.splitsForOthers}, conflicts ${together.conflicts}, ${plural(together.overlap.length, 'file')} changed by two agents, ${plural(together.steers, 'steer')} (${together.steersForMeld} doing the work of meld).`,
      `Shared context: ${plural(context.entries.fact, 'fact')}, ${plural(context.entries.fail, 'fail')}, ${plural(context.entries.interface, 'interface')}; ${context.delivered} of ${context.all} reached another agent, in ${minutes(context.deliveryMs)}; ${context.cited} of ${context.received} cited; ${context.failsHeeded} of ${context.failsReceived} fails heeded; ${context.repeatedFails} repeated.`,
      `Workload: balance ${workload.balance.toFixed(2)}, spread ${workload.spread.toFixed(2)}, largest task ${percent(workload.largestTaskShare)} of the weight${mix ? `; ${mix}` : ''}.`,
    ],
    workers: efficiency.workers.map((worker, index) => {
      const share = workload.shares[index]?.share ?? 0
      const idle = workload.idleWhileOthersWork[index]?.ms ?? 0
      return `${worker.worker}: busy ${minutes(worker.busyMs)} of ${minutes(worker.workerMs)}, ${percent(share)} of the work, ${minutes(idle)} idle while others worked, ${tokenCount(worker.costUnits)} tokens.`
    }),
  }
}

/** The time an archived run ended: its end, else its last event. */
export function endOf(run: Run): number {
  return run.endedAt ?? run.log.at(-1)?.at ?? run.startedAt
}

/** The report as text, for /meld-report and the archive: the story, the lanes of the whole run in cells, and the metrics. */
export function reportText(run: Run, now: number): string {
  const report = reportOf(run, now)
  const window = { from: run.startedAt, to: run.endedAt ?? now }
  const lanes = lanesOf(run, now)
    .filter(lane => lane.to > lane.from)
    .map(lane => `${lane.worker} ${flowCells(partsIn(lane.parts, window), sleepsOf(run), window, FLOW_CELLS)}`)
  return [report.story, ['```', ...lanes, FLOW_LEGEND, '```'].join('\n'), [...report.run, ...report.team, ...report.workers].join('\n')].join('\n\n')
}

/** A run that meld archived at Deliver or Discard, or undefined when its record is missing or broken. */
export async function archivedRun(io: CodeHost & Archive, id: string): Promise<Run | undefined> {
  if (!SAFE_ID.test(id)) return undefined
  try {
    const folder = await io.archiveFolder()
    const read = await command(io, folder, ['cat', '--', `${folder}/${id}.json`])
    if (!read.ok) return undefined
    const record = JSON.parse(read.out) as ArchiveRecord
    return { ...record.run, request: record.board.request, tasks: record.board.tasks, log: record.events, context: record.context }
  } catch {
    return undefined
  }
}

/** Section 4.6: one row for each of the newest archived runs, so the person sees if a change of meld, the agents or the request helps. */
async function runsTable(io: CodeHost & Archive & Files): Promise<string> {
  const entries = await io.archiveFolder().then(folder => io.list(folder), () => [])
  const ids = entries
    .filter(entry => entry.kind === 'file' && entry.name.endsWith('.json'))
    .sort((one, two) => two.mtimeMs - one.mtimeMs)
    .slice(0, RUNS_SHOWN)
    .map(entry => entry.name.slice(0, -'.json'.length))
  const rows: string[] = []
  for (const id of ids) {
    const run = await archivedRun(io, id)
    if (!run) continue
    const now = endOf(run)
    const efficiency = efficiencyOf(run, now)
    const progress = progressOf(run, now)
    const context = sharedContextOf(run, now)
    const cells = [
      run.id,
      run.workers.length,
      progress.done,
      minutes(efficiency.runMs),
      percent(efficiency.busyShare),
      minutes(efficiency.aloneMs),
      minutes(progress.readyNoAgent.ms),
      workloadOf(run, now).balance.toFixed(2),
      `${context.cited} of ${context.received}`,
      efficiency.rework.toFixed(2),
      percent(efficiency.cacheReadShare),
      tokenCount(efficiency.costPerTask),
    ]
    rows.push(`| ${cells.join(' | ')} |`)
  }
  return rows.length ? [RUNS_HEADER, ...rows].join('\n') : 'meld has archived no run yet. Deliver and Discard archive a run.'
}

/** /meld-report: the report of the run of the session, of an archived run by its id, or with --runs the table of the archived runs. */
export async function reportCommand(io: Store & Clock & CodeHost & Archive & Files, args: string): Promise<string> {
  if (args === '--runs') return runsTable(io)
  if (args) {
    const run = await archivedRun(io, args)
    return run ? reportText(run, endOf(run)) : `meld has no archived run ${args}.`
  }
  const run = await io.read()
  return run ? reportText(run, await io.now()) : NO_RUN
}
