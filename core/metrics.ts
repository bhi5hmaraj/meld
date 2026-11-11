import type { Activity, ActivityTimes, ContextKind, Entry, Run, Task, TokenSums, WaitReason, WorkerId } from '../types'
import { handoversFor } from './board'
import { weightOf } from './progress'
import { childrenOf, claimable, isParent, taskOf, waitsFor } from './tasks'

/**
 * The metrics of section 4 of docs/design/pane-metrics-logs.md. Each one is a pure function of the run, the time now and
 * the events, which are the run log unless the caller has the full events of the store. The pane, the report and the
 * hosted service use the same functions.
 */

/** The classes of a command, in order: the first rule that matches wins (section 4.3 of docs/design/pane-metrics-logs.md). */
export const ACTIVITY_RULES: [Activity, RegExp][] = [
  ['tests', /\b(pytest|vitest|jest|bun test|go test|cargo test|npm test|npm run test|plugin test)\b/],
  ['builds', /\b(tsc|build|compile)\b|\b(npm|bun|pnpm|yarn|pip3?|uv|cargo|go|brew) (install|add|ci|i)\b/],
  ['app', /\blocalhost\b|\b127\.0\.0\.1\b|\b(npm|bun|pnpm|yarn) (run )?(dev|start)\b|\bdev server\b/],
  ['background', /\btail -f\b|\bsleep\b|\buntil\b/],
]
const BOARD_TOOL = /^mcp__(plugin_)?meld/
const BROWSER_TOOL = /browser|chrome|playwright/i
const NAMES_TESTS = /\btests?\b/i

/** The class of one tool call, for the time by activity and the words of a card. */
export function activityOf(tool: string, command = '', description = ''): Activity {
  if (BOARD_TOOL.test(tool)) return 'board'
  if (BROWSER_TOOL.test(tool)) return 'app'
  if (NAMES_TESTS.test(description)) return 'tests'
  return ACTIVITY_RULES.find(([, rule]) => rule.test(command))?.[0] ?? 'tools'
}

/** The price of each kind of token, in cost units: an input token is 1. */
export const PRICE: Readonly<TokenSums> = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }
/** The window of the rate. */
export const RATE_MS = 10 * 60_000

export function costUnits(usage: TokenSums): number {
  return usage.input * PRICE.input + usage.cacheWrite * PRICE.cacheWrite + usage.cacheRead * PRICE.cacheRead + usage.output * PRICE.output
}

/** A part of a lane: work on a task, a merge of a task, a wait on meld (with its reason, or none for a ready task), idle time or sleep. */
export type LaneKind = 'working' | 'merging' | 'waiting' | 'idle' | 'asleep'
export type LanePart = { kind: LaneKind; from: number; to: number; task?: number; reason?: WaitReason }
/** The worker time of one worker, from its start to its stop or the end of the run, in parts that join end to end. */
export type Lane = { worker: WorkerId; from: number; to: number; parts: LanePart[] }

type Span = { from: number; to: number }
type Claim = Span & { worker: WorkerId; task: number }
type Merge = Span & { task?: number }
type LaneFacts = { sleeps: Span[]; records: Entry[]; claims: Claim[]; merges: Merge[]; ready: Span[] }

const CLAIMED = /^claimed #(\d+)/
const ENDED = /^(?:released|finished) #(\d+)/
const SPLIT = /^split #(\d+) into (.*), and claimed #(\d+)$/
const STOPPED = /^stopped (w\d+)$/
const TASK_ID = /#(\d+)/g
/** ponytail: a word match, so "start the idle workers" and "integrate" count; a record of the steer kind if it misleads. */
const STEER_FOR_MELD = /\b(start|integrat)/i
const BUSY: ReadonlySet<LaneKind> = new Set(['working', 'merging'])

function endOf(run: Run, now: number): number {
  return run.endedAt ?? now
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

function ratio(part: number, whole: number): number {
  return whole ? part / whole : 0
}

function inside(span: Span, at: number): boolean {
  return span.from <= at && at < span.to
}

/** The spans between adjacent sorted cuts. */
function gapsOf(cuts: readonly number[]): Span[] {
  return cuts.slice(1).map((to, index) => ({ from: cuts[index] ?? to, to }))
}

/** The time in which the number of spans that cover it passes the test. ponytail: O(n^2) over the cuts, fine for a few thousand spans. */
function msWhere(spans: readonly Span[], keep: (count: number) => boolean): number {
  const cuts = [...new Set(spans.flatMap(span => [span.from, span.to]))].sort((a, b) => a - b)
  return gapsOf(cuts)
    .filter(gap => keep(spans.filter(span => inside(span, gap.from)).length))
    .reduce((sum, gap) => sum + gap.to - gap.from, 0)
}

function leavesOf(run: Run): Task[] {
  return run.tasks.filter(task => !isParent(run.tasks, task.id))
}

function doneLeaves(run: Run): Task[] {
  return leavesOf(run).filter(task => task.state === 'done')
}

function weightSum(tasks: readonly Task[]): number {
  return tasks.reduce((sum, task) => sum + weightOf(task), 0)
}

/**
 * The claims of the run, replayed from the task entries: a claim runs from `claimed #N` (or the claim of a split) to the
 * release, the finish, the split of its task, or the stop of its worker. An open claim runs to the end. A claim that the
 * trimmed log lost comes from the owner and claimedAt of its task.
 */
function claimsOf(run: Run, events: readonly Entry[], end: number): Claim[] {
  const open = new Map<number, Claim>()
  const claims: Claim[] = []
  const close = (task: number, at: number) => {
    const claim = open.get(task)
    if (claim) claims.push({ ...claim, to: Math.max(claim.from, at) })
    open.delete(task)
  }
  for (const entry of events) {
    const stopped = entry.kind === 'event' ? STOPPED.exec(entry.text) : null
    if (stopped) for (const claim of [...open.values()].filter(one => one.worker === stopped[1])) close(claim.task, entry.at)
    if (entry.kind !== 'task' || entry.by === 'you') continue
    const split = SPLIT.exec(entry.text)
    const ended = ENDED.exec(entry.text)
    const claimed = split?.[3] ?? CLAIMED.exec(entry.text)?.[1]
    if (split) close(Number(split[1]), entry.at)
    if (ended) close(Number(ended[1]), entry.at)
    if (claimed === undefined) continue
    close(Number(claimed), entry.at)
    open.set(Number(claimed), { worker: entry.by, task: Number(claimed), from: entry.at, to: end })
  }
  claims.push(...open.values())
  const lost = run.tasks.flatMap(task =>
    task.owner && task.claimedAt !== undefined && !claims.some(claim => claim.task === task.id && claim.from === task.claimedAt)
      ? [{ worker: task.owner, task: task.id, from: task.claimedAt, to: Math.max(task.claimedAt, task.doneAt ?? end) }]
      : [],
  )
  return [...claims, ...lost]
}

/** The times in which a leaf was ready and no worker held it: from readyAt to its finish, less its claims. */
function readySpans(run: Run, claims: readonly Claim[], end: number): Span[] {
  return leavesOf(run).flatMap(task => {
    if (task.readyAt === undefined) return []
    const stop = task.state === 'done' ? (task.doneAt ?? task.readyAt) : end
    const spans: Span[] = []
    let from = task.readyAt
    for (const claim of claims.filter(one => one.task === task.id).sort((a, b) => a.from - b.from)) {
      if (claim.from > from) spans.push({ from, to: Math.min(claim.from, stop) })
      from = Math.max(from, claim.to)
    }
    spans.push({ from, to: stop })
    return spans.filter(span => span.to > span.from)
  })
}

/** What a worker does at one time, in this order: sleep, work, a merge, a wait for its own background work, a wait on meld, idle. */
function partAt(at: number, facts: LaneFacts): Omit<LanePart, 'from' | 'to'> {
  if (facts.sleeps.some(span => inside(span, at))) return { kind: 'asleep' }
  const record = facts.records.findLast(entry => entry.at <= at)
  const state = record ? (record.state ?? 'working') : undefined
  const claim = facts.claims.findLast(span => inside(span, at))
  const task = claim ? { task: claim.task } : {}
  if (claim && (state === undefined || state === 'working')) return { kind: 'working', ...task }
  const merge = facts.merges.findLast(span => inside(span, at))
  if (merge) return { kind: 'merging', ...(merge.task === undefined ? {} : { task: merge.task }) }
  if (state === 'waiting' && record?.reason === 'background') return { kind: 'idle', reason: 'background' }
  if (state === 'waiting') return { kind: 'waiting', ...task, ...(record?.reason ? { reason: record.reason } : {}) }
  if (claim) return { kind: 'waiting', ...task, reason: 'restart' }
  if (facts.ready.some(span => inside(span, at))) return { kind: 'waiting' }
  return { kind: 'idle' }
}

/** One lane for each worker (section 3.4). The parts of a lane join end to end and add up to its worker time. */
export function lanesOf(run: Run, now: number, events: readonly Entry[] = run.log): Lane[] {
  const end = endOf(run, now)
  const claims = claimsOf(run, events, end)
  const ready = readySpans(run, claims, end)
  const sleeps = events.filter(entry => entry.kind === 'host').map(entry => ({ from: entry.from ?? entry.at, to: entry.at }))
  return run.workers.map(worker => {
    const records = events.filter(entry => entry.kind === 'worker' && entry.worker === worker.id)
    const joined = events.find(entry => entry.kind === 'event' && entry.text === `${worker.id} joined the run`)
    const stops = events.filter(entry => (entry.kind === 'event' && entry.text === `stopped ${worker.id}`) || (entry.kind === 'worker' && entry.worker === worker.id && entry.state === 'stopped'))
    const from = clamp(records.find(entry => entry.start)?.at ?? joined?.at ?? run.startedAt, run.startedAt, end)
    const to = clamp(stops.at(-1)?.at ?? end, from, end)
    const merges = events.filter(entry => entry.kind === 'merge' && entry.worker === worker.id).map(entry => ({ from: entry.from ?? entry.at, to: entry.at, task: entry.task }))
    const facts: LaneFacts = { sleeps, records, claims: claims.filter(claim => claim.worker === worker.id), merges, ready }
    const points = [from, to, ...[...facts.claims, ...merges, ...sleeps, ...ready].flatMap(span => [span.from, span.to]), ...records.map(entry => entry.at)]
    const cuts = [...new Set(points.filter(point => point >= from && point <= to))].sort((a, b) => a - b)
    const parts: LanePart[] = []
    for (const gap of gapsOf(cuts)) {
      const part = partAt(gap.from, facts)
      const last = parts.at(-1)
      if (last && last.kind === part.kind && last.task === part.task && last.reason === part.reason) last.to = gap.to
      else parts.push({ kind: part.kind, ...gap, ...(part.task === undefined ? {} : { task: part.task }), ...(part.reason ? { reason: part.reason } : {}) })
    }
    return { worker: worker.id, from, to, parts }
  })
}

function msOf(lane: Lane, keep: (part: LanePart) => boolean): number {
  return lane.parts.filter(keep).reduce((sum, part) => sum + part.to - part.from, 0)
}

function busySpans(lane: Lane): LanePart[] {
  return lane.parts.filter(part => BUSY.has(part.kind))
}

/** The time of a worker by activity: its records by tool class, and from its lane the merges, the waits, the idle time and the sleep. */
export type Times = ActivityTimes & { merge: number; waiting: number; idle: number; asleep: number }
export type WorkerEfficiency = { worker: WorkerId; workerMs: number; busyMs: number; costUnits: number; largestContext?: number; meanContext?: number; times: Times }
export type Efficiency = {
  runMs: number
  workerMs: number
  busyMs: number
  busyShare: number
  parallelism: number
  /** Waits for a restart, an approval or a merge: the waits with a reason. A ready task with no agent counts in the progress. */
  waitingMs: number
  aloneMs: number
  asleepMs: number
  idleRestarts: number
  checks: number
  failedChecks: number
  rework: number
  costUnits: number
  costPerTask: number
  cacheReadShare: number
  workers: WorkerEfficiency[]
}

/** Section 4.1: does the parallel work pay? */
export function efficiencyOf(run: Run, now: number, events: readonly Entry[] = run.log): Efficiency {
  const end = endOf(run, now)
  const lanes = lanesOf(run, now, events)
  const workers = run.workers.map((worker, index): WorkerEfficiency => {
    const lane = lanes[index] ?? { worker: worker.id, from: end, to: end, parts: [] }
    const usage = worker.usage
    const context = usage && worker.steps ? { meanContext: (usage.input + usage.cacheWrite + usage.cacheRead) / worker.steps } : {}
    const times: Times = {
      ...worker.times,
      merge: msOf(lane, part => part.kind === 'merging'),
      waiting: msOf(lane, part => part.kind === 'waiting'),
      idle: msOf(lane, part => part.kind === 'idle'),
      asleep: msOf(lane, part => part.kind === 'asleep'),
    }
    return {
      worker: worker.id,
      workerMs: lane.to - lane.from,
      busyMs: msOf(lane, part => BUSY.has(part.kind)),
      costUnits: usage ? costUnits(usage) : worker.tokens,
      ...(worker.largestContext === undefined ? {} : { largestContext: worker.largestContext }),
      ...context,
      times,
    }
  })
  const runMs = end - run.startedAt
  const workerMs = workers.reduce((sum, one) => sum + one.workerMs, 0)
  const busyMs = workers.reduce((sum, one) => sum + one.busyMs, 0)
  const checks = events.filter(entry => entry.kind === 'check')
  const failedChecks = checks.filter(entry => entry.passed === false).length
  const finished = doneLeaves(run).length
  const releases = run.tasks.reduce((sum, task) => sum + (task.releases ?? 0), 0)
  const integrates = run.tasks.filter(task => task.integrates !== undefined).length
  const units = workers.reduce((sum, one) => sum + one.costUnits, 0)
  const usages = run.workers.flatMap(worker => (worker.usage ? [worker.usage] : []))
  const sleeps = events.filter(entry => entry.kind === 'host').map(entry => ({ from: clamp(entry.from ?? entry.at, run.startedAt, end), to: clamp(entry.at, run.startedAt, end) }))
  return {
    runMs,
    workerMs,
    busyMs,
    busyShare: ratio(busyMs, workerMs),
    parallelism: ratio(busyMs, runMs),
    waitingMs: lanes.reduce((sum, lane) => sum + msOf(lane, part => part.kind === 'waiting' && part.reason !== undefined), 0),
    aloneMs: msWhere(lanes.flatMap(busySpans), count => count === 1),
    asleepMs: msWhere(sleeps, count => count > 0),
    idleRestarts: events.filter(entry => entry.kind === 'worker' && entry.start && entry.noTask).length,
    checks: checks.length,
    failedChecks,
    rework: ratio(releases + integrates + failedChecks, finished),
    costUnits: units,
    costPerTask: ratio(units, finished),
    cacheReadShare: ratio(
      usages.reduce((sum, usage) => sum + usage.cacheRead * PRICE.cacheRead, 0),
      usages.reduce((sum, usage) => sum + costUnits(usage), 0),
    ),
    workers,
  }
}

export type Path = { tasks: number; weight: number }
export type Progress = {
  /** Counts over leaves: done, claimed, ready to claim, and waiting for a need. */
  done: number
  working: number
  ready: number
  waiting: number
  doneWeight: number
  allWeight: number
  /** Ready tasks now while a worker waits for one, and the time so far in which a ready task had no agent. */
  readyNoAgent: { now: number; ms: number }
  scopeGrowth: number
  /** The weight done in the last RATE_MS. */
  rate: number
  criticalPath: Path
  /** Open leaves that wait for a need, and the task that holds back the most of them. */
  blocked: { count: number; top?: number; blocks: number }
  /** The mean time from the claim to the finish of a done leaf. */
  taskMs: number
}

/** The longest chain of needs from a task that is not done, through the parts of a parent. ponytail: no memo, fine for a board of tens of tasks. */
function pathOf(tasks: readonly Task[], id: number, seen: ReadonlySet<number>): Path {
  const task = taskOf(tasks, id)
  if (!task || task.state === 'done' || seen.has(id)) return { tasks: 0, weight: 0 }
  const next = new Set(seen).add(id)
  const parts = childrenOf(tasks, id)
  const longest = [...(task.needs ?? []), ...parts.map(part => part.id)]
    .map(one => pathOf(tasks, one, next))
    .reduce((best, one) => (one.weight > best.weight ? one : best), { tasks: 0, weight: 0 })
  return parts.length ? longest : { tasks: longest.tasks + 1, weight: longest.weight + weightOf(task) }
}

/** Section 4.2: how far is the run? */
export function progressOf(run: Run, now: number, events: readonly Entry[] = run.log): Progress {
  const end = endOf(run, now)
  const leaves = leavesOf(run)
  const done = leaves.filter(task => task.state === 'done')
  const open = leaves.filter(task => task.state === 'open')
  const ready = claimable(run.tasks).length
  const lanes = lanesOf(run, now, events)
  const waitsForTask = lanes.flatMap(lane => lane.parts.filter(part => part.kind === 'waiting' && part.reason === undefined))
  const waitingNow = lanes.some(lane => lane.to === end && lane.parts.at(-1)?.kind === 'waiting' && lane.parts.at(-1)?.reason === undefined)
  const added = run.tasks.flatMap(task => (task.addedAt === undefined ? [] : [task.addedAt]))
  const firstAt = Math.min(...added)
  const later = run.tasks.filter(task => task.addedAt !== undefined && task.addedAt > firstAt).length
  const blockers = open.flatMap(task => {
    const need = waitsFor(run.tasks, task)
    return need === undefined ? [] : [need]
  })
  const counts = new Map<number, number>()
  for (const need of blockers) counts.set(need, (counts.get(need) ?? 0) + 1)
  const top = [...counts].reduce<[number, number] | undefined>((best, one) => (!best || one[1] > best[1] ? one : best), undefined)
  const timed = done.filter(task => task.claimedAt !== undefined && task.doneAt !== undefined)
  return {
    done: done.length,
    working: leaves.filter(task => task.state === 'claimed').length,
    ready,
    waiting: open.length - ready,
    doneWeight: weightSum(done),
    allWeight: weightSum(leaves),
    readyNoAgent: { now: waitingNow ? ready : 0, ms: msWhere(waitsForTask, count => count > 0) },
    scopeGrowth: ratio(later, run.tasks.length - later),
    rate: weightSum(done.filter(task => (task.doneAt ?? 0) >= end - RATE_MS)),
    criticalPath: run.tasks.map(task => pathOf(run.tasks, task.id, new Set())).reduce((best, one) => (one.weight > best.weight ? one : best), { tasks: 0, weight: 0 }),
    blocked: { count: blockers.length, ...(top ? { top: top[0] } : {}), blocks: top?.[1] ?? 0 },
    taskMs: ratio(
      timed.reduce((sum, task) => sum + (task.doneAt ?? 0) - (task.claimedAt ?? 0), 0),
      timed.length,
    ),
  }
}

export type Collaboration = {
  /** Owned tasks whose needs another worker did, of the owned tasks with needs. */
  crossNeeds: number
  withNeeds: number
  handoversUsed: number
  commitsTaken: number
  splitsForOthers: number
  conflicts: number
  /** Files that the merges of two or more workers changed. */
  overlap: string[]
  steers: number
  steersForMeld: number
}

function doersOf(tasks: readonly Task[], id: number): WorkerId[] {
  const parts = childrenOf(tasks, id)
  if (parts.length) return parts.flatMap(part => doersOf(tasks, part.id))
  const owner = taskOf(tasks, id)?.owner
  return owner ? [owner] : []
}

/** Section 4.3: do the agents work together? */
export function collaborationOf(run: Run, now: number, events: readonly Entry[] = run.log): Collaboration {
  const withNeeds = run.tasks.filter(task => task.owner && task.needs?.length)
  const crossNeeds = withNeeds.filter(task => task.needs?.some(need => doersOf(run.tasks, need).some(doer => doer !== task.owner)))
  const claims = claimsOf(run, events, endOf(run, now))
  const splitParts = events.flatMap(entry => {
    const split = entry.kind === 'task' ? SPLIT.exec(entry.text) : null
    return split ? [...(split[2] ?? '').matchAll(TASK_ID)].map(match => ({ by: entry.by, task: Number(match[1]) })) : []
  })
  const changers = new Map<string, Set<WorkerId>>()
  for (const entry of events.filter(one => one.kind === 'merge' && one.worker)) {
    for (const file of entry.files ?? []) changers.set(file, (changers.get(file) ?? new Set()).add(entry.worker as WorkerId))
  }
  const steers = events.filter(entry => entry.kind === 'steer')
  return {
    crossNeeds: crossNeeds.length,
    withNeeds: withNeeds.length,
    handoversUsed: claims.filter(claim => handoversFor(run, claim.task).length > 0).length,
    commitsTaken: run.tasks.reduce((sum, task) => sum + (task.taken ?? 0), 0),
    splitsForOthers: splitParts.filter(part => {
      const owner = taskOf(run.tasks, part.task)?.owner
      return owner !== undefined && owner !== part.by
    }).length,
    conflicts: run.tasks.filter(task => task.integrates !== undefined).length,
    overlap: [...changers].filter(([, workers]) => workers.size > 1).map(([file]) => file).sort(),
    steers: steers.length,
    steersForMeld: steers.filter(entry => STEER_FOR_MELD.test(entry.text)).length,
  }
}

export type SharedContext = {
  entries: Record<ContextKind, number>
  perTask: number
  /** Entries that reached at least one other worker, of all entries. */
  delivered: number
  all: number
  /** The median time from an entry to its first delivery. */
  deliveryMs: number
  /** Entries that the finishes of a worker name in used and that it received, of the entries it received. */
  cited: number
  received: number
  workers: { worker: WorkerId; cited: number; received: number }[]
  /** Fails with receivers that no receiver failed again on the same files after it received them, of the fails with receivers. */
  failsHeeded: number
  failsReceived: number
  /** Fails on the files of a fail of another worker that the author received before. */
  repeatedFails: number
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const high = sorted[middle] ?? 0
  return sorted.length % 2 ? high : ((sorted[middle - 1] ?? high) + high) / 2
}

/** Section 4.4: do the agents learn from each other? */
export function sharedContextOf(run: Run, _now: number, events: readonly Entry[] = run.log): SharedContext {
  const context = run.context ?? []
  const receipts = new Map<number, Map<WorkerId, number>>(context.map(entry => [entry.id, new Map()]))
  for (const entry of events) {
    const got = entry.kind === 'delivered' && entry.worker && entry.context !== undefined ? receipts.get(entry.context) : undefined
    if (got && entry.worker && !got.has(entry.worker)) got.set(entry.worker, entry.at)
  }
  const delays = context.flatMap(entry => {
    const times = [...(receipts.get(entry.id)?.values() ?? [])]
    return times.length ? [Math.min(...times) - entry.at] : []
  })
  for (const entry of context) for (const worker of entry.seenBy) if (!receipts.get(entry.id)?.has(worker)) receipts.get(entry.id)?.set(worker, entry.at)
  const workers = run.workers.map(worker => {
    const got = new Set(context.filter(entry => receipts.get(entry.id)?.has(worker.id)).map(entry => entry.id))
    const used = new Set(run.tasks.filter(task => task.owner === worker.id && task.state === 'done').flatMap(task => task.used ?? []))
    return { worker: worker.id, cited: [...used].filter(id => got.has(id)).length, received: got.size }
  })
  const fails = context.filter(entry => entry.kind === 'fail')
  const shareFile = (one: { files: string[] }, other: { files: string[] }) => one.files.some(file => other.files.includes(file))
  const received = fails.filter(entry => receipts.get(entry.id)?.size)
  const heeded = received.filter(entry =>
    [...(receipts.get(entry.id) ?? [])].every(([worker, at]) => !fails.some(other => other.by === worker && other.at > at && shareFile(entry, other))),
  )
  const repeated = fails.filter(entry =>
    fails.some(first => first.by !== entry.by && shareFile(first, entry) && (receipts.get(first.id)?.get(entry.by) ?? Infinity) < entry.at),
  )
  return {
    entries: {
      fact: context.filter(entry => entry.kind === 'fact').length,
      fail: fails.length,
      interface: context.filter(entry => entry.kind === 'interface').length,
    },
    perTask: ratio(context.length, doneLeaves(run).length),
    delivered: context.filter(entry => receipts.get(entry.id)?.size).length,
    all: context.length,
    deliveryMs: median(delays),
    cited: workers.reduce((sum, one) => sum + one.cited, 0),
    received: workers.reduce((sum, one) => sum + one.received, 0),
    workers,
    failsHeeded: heeded.length,
    failsReceived: received.length,
    repeatedFails: repeated.length,
  }
}

export type Workload = {
  /** The done weight of each worker, of the done weight of the run. */
  shares: { worker: WorkerId; share: number }[]
  balance: number
  spread: number
  largestTaskShare: number
  idleWhileOthersWork: { worker: WorkerId; ms: number }[]
  agentMix: { type: string; share: number; rework: number }[]
}

/** Section 4.5: is the work fair and balanced? */
export function workloadOf(run: Run, now: number, events: readonly Entry[] = run.log): Workload {
  const lanes = lanesOf(run, now, events)
  const done = doneLeaves(run)
  const doneWeight = weightSum(done)
  const busy = lanes.map(lane => msOf(lane, part => BUSY.has(part.kind)))
  const mean = ratio(busy.reduce((sum, ms) => sum + ms, 0), busy.length)
  const deviation = Math.sqrt(ratio(busy.reduce((sum, ms) => sum + (ms - mean) ** 2, 0), busy.length))
  const types = [...new Set(run.workers.map(worker => worker.agent.type))]
  return {
    shares: run.workers.map(worker => ({ worker: worker.id, share: ratio(weightSum(done.filter(task => task.owner === worker.id)), doneWeight) })),
    balance: ratio(mean, Math.max(0, ...busy)),
    spread: ratio(deviation, mean),
    largestTaskShare: ratio(Math.max(0, ...leavesOf(run).map(weightOf)), weightSum(leavesOf(run))),
    idleWhileOthersWork: lanes.map(lane => {
      const others = lanes.filter(other => other !== lane).flatMap(busySpans)
      const free = lane.parts.filter(part => part.kind === 'idle' || part.kind === 'waiting')
      const ms = free.reduce((sum, part) => sum + msWhere(others.map(span => ({ from: clamp(span.from, part.from, part.to), to: clamp(span.to, part.from, part.to) })), count => count > 0), 0)
      return { worker: lane.worker, ms }
    }),
    agentMix: types.map(type => {
      const ids = new Set(run.workers.filter(worker => worker.agent.type === type).map(worker => worker.id))
      const theirs = done.filter(task => task.owner && ids.has(task.owner))
      const byThem = events.filter(entry => entry.by !== 'you' && ids.has(entry.by))
      const releases = byThem.filter(entry => entry.kind === 'task' && ENDED.exec(entry.text)?.[0].startsWith('released')).length
      const failed = byThem.filter(entry => entry.kind === 'check' && entry.passed === false).length
      const integrates = theirs.filter(task => task.integrates !== undefined).length
      return { type, share: ratio(weightSum(theirs), doneWeight), rework: ratio(releases + failed + integrates, theirs.length) }
    }),
  }
}
