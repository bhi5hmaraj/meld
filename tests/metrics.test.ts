import { expect, test } from 'claude-code/testing'

import { activityOf, collaborationOf, costUnits, efficiencyOf, lanesOf, progressOf, sharedContextOf, workloadOf } from '../core/metrics'
import type { Entry, LaneState, Run, Task, WaitReason, WorkerId } from '../types'

const BASH = 'Bash'
const T0 = 1_800_000_000_000
const MIN = 60_000
const NOW = T0 + 40 * MIN
const COMMIT = 'c'.repeat(40)
const TITLE = 'A task'
const SUMMARY = 'did it'
const CLAIMED_1 = 'claimed #1'
const CLAIMED_2 = 'claimed #2'
const FINISHED_1 = 'finished #1: did it'
const CHECK = 'bun test'
const FILE_A = 'core/a.ts'
const FILE_B = 'core/b.ts'
const WORKER_AGENT = 'meld:worker'
const OTHER_AGENT = 'acp:other'
const SEEDS = 300
const EVENTS = 40
const STATES: LaneState[] = ['working', 'idle', 'waiting', 'stopped']
const REASONS: (WaitReason | undefined)[] = ['restart', 'approval', 'merge', 'background', undefined]
const IDS: WorkerId[] = ['w1', 'w2', 'w3', 'w4']

function runOf(tasks: Task[], log: Entry[], extra: Partial<Run> = {}): Run {
  const workers = (['w1', 'w2'] as WorkerId[]).map(id => ({
    id,
    agent: { type: id === 'w1' ? WORKER_AGENT : OTHER_AGENT },
    path: `/tmp/meld/r1/${id}`,
    ref: `meld/r1/${id}`,
    state: 'working' as const,
    briefed: true,
    seenRevision: 1,
    seenEntry: 0,
    activity: '',
    activityAt: T0,
    tokens: 0,
  }))
  const entries = log.map((entry, index) => ({ ...entry, id: index + 1 }))
  return { id: 'r1', request: 'Add a theme', revision: 1, state: 'working', vcs: 'git', repo: '/repo', base: COMMIT, startedAt: T0, workers, tasks, log: entries, nudges: 0, taskList: 1, ...extra }
}

/** w1 does #1 and merges it, then waits for a ready #2 with w2. w2 claims #2, the machine sleeps, w2 waits for an approval and for a restart. */
function storyRun(): Run {
  const tasks: Task[] = [
    { id: 1, title: TITLE, detail: '', state: 'done', owner: 'w1', version: 3, size: 'M', addedAt: T0, readyAt: T0, claimedAt: T0, doneAt: T0 + 10 * MIN, commit: COMMIT, summary: SUMMARY, handover: { interfaces: 'theme()' }, taken: 2 },
    { id: 2, title: TITLE, detail: '', state: 'claimed', owner: 'w2', version: 2, size: 'S', needs: [1], addedAt: T0, readyAt: T0 + 10 * MIN, claimedAt: T0 + 14 * MIN, releases: 1 },
    { id: 3, title: TITLE, detail: '', state: 'open', version: 1, size: 'S', needs: [2], addedAt: T0 + 5 * MIN },
  ]
  const log = [
    { at: T0, by: 'you', kind: 'worker', text: '', worker: 'w1', start: 'start' },
    { at: T0, by: 'you', kind: 'worker', text: '', worker: 'w2', start: 'start' },
    { at: T0, by: 'w1', kind: 'task', text: CLAIMED_1, task: 1 },
    { at: T0 + 1 * MIN, by: 'you', kind: 'worker', text: '', worker: 'w2', state: 'idle' },
    { at: T0 + 9 * MIN, by: 'w1', kind: 'check', text: CHECK, passed: false },
    { at: T0 + 9 * MIN, by: 'w1', kind: 'check', text: CHECK, passed: true },
    { at: T0 + 10 * MIN, by: 'w1', kind: 'task', text: FINISHED_1, task: 1 },
    { at: T0 + 10 * MIN, by: 'you', kind: 'worker', text: '', worker: 'w1', state: 'idle' },
    { at: T0 + 11 * MIN, by: 'you', kind: 'merge', text: '', worker: 'w1', task: 1, from: T0 + 10 * MIN, files: [FILE_A] },
    { at: T0 + 12 * MIN, by: 'you', kind: 'worker', text: '', worker: 'w1', start: 'restart', noTask: true, state: 'idle' },
    { at: T0 + 14 * MIN, by: 'you', kind: 'worker', text: '', worker: 'w2', start: 'restart' },
    { at: T0 + 14 * MIN, by: 'w2', kind: 'task', text: CLAIMED_2, task: 2 },
    { at: T0 + 30 * MIN, by: 'you', kind: 'host', text: '', from: T0 + 20 * MIN },
    { at: T0 + 30 * MIN, by: 'you', kind: 'worker', text: '', worker: 'w2', state: 'waiting', reason: 'approval' },
    { at: T0 + 32 * MIN, by: 'you', kind: 'worker', text: '', worker: 'w2', state: 'working' },
    { at: T0 + 36 * MIN, by: 'you', kind: 'worker', text: '', worker: 'w2', state: 'idle' },
    { at: T0 + 38 * MIN, by: 'you', kind: 'worker', text: '', worker: 'w2', start: 'restart' },
  ] as Entry[]
  const run = runOf(tasks, log)
  const [w1, w2] = run.workers
  const usage = { input: 1000, cacheWrite: 2000, cacheRead: 10_000, output: 500 }
  const workers = [{ ...w1, usage, steps: 10, largestContext: 120_000, times: { model: 5 * MIN, tests: 2 * MIN } }, { ...w2, tokens: 3000 }]
  return { ...run, workers }
}

/** A seeded number in [0, 1) for each seed and step (mulberry32), so a broken rule shows again with its seed. */
function roll(seed: number, step: number): number {
  let state = (seed * 7919 + step * 104_729 + 0x6d2b79f5) | 0
  state = Math.imul(state ^ (state >>> 15), 1 | state)
  state = (state + Math.imul(state ^ (state >>> 7), 61 | state)) ^ state
  return ((state ^ (state >>> 14)) >>> 0) / 4294967296
}

/** A run of random records in any order: claims, releases, finishes and stops that need not agree, states, merges and sleeps. */
function randomRun(seed: number): Run {
  let step = 0
  const workers = IDS.slice(0, 1 + Math.floor(roll(seed, step++) * IDS.length))
  const tasks: Task[] = [1, 2, 3, 4, 5].map(id => ({ id, title: TITLE, detail: '', state: 'open', version: 1, addedAt: T0, readyAt: T0 + Math.floor(roll(seed, step++) * 30 * MIN) }))
  tasks[0] = { ...tasks[0], state: 'claimed', owner: workers[0], claimedAt: T0 + 3 * MIN }
  const log: Entry[] = []
  let at = T0
  for (let index = 0; index < EVENTS; index++) {
    at += Math.floor(roll(seed, step++) * 3 * MIN)
    const worker = workers[Math.floor(roll(seed, step++) * workers.length)]
    const task = 1 + Math.floor(roll(seed, step++) * tasks.length)
    const back = Math.floor(roll(seed, step++) * 20 * MIN)
    const kind = Math.floor(roll(seed, step++) * 8)
    const state = STATES[Math.floor(roll(seed, step++) * STATES.length)]
    const reason = REASONS[Math.floor(roll(seed, step++) * REASONS.length)]
    if (kind === 0) log.push({ id: 0, at, by: worker, kind: 'task', text: `claimed #${task}` })
    if (kind === 1) log.push({ id: 0, at, by: worker, kind: 'task', text: `released #${task}` })
    if (kind === 2) log.push({ id: 0, at, by: worker, kind: 'task', text: `finished #${task}: ${SUMMARY}` })
    if (kind === 3) log.push({ id: 0, at, by: 'you', kind: 'worker', text: '', worker, state, reason })
    if (kind === 4) log.push({ id: 0, at, by: 'you', kind: 'merge', text: '', worker, task, from: at - back, files: [] })
    if (kind === 5) log.push({ id: 0, at, by: 'you', kind: 'host', text: '', from: at - back })
    if (kind === 6) log.push({ id: 0, at, by: 'you', kind: 'worker', text: '', worker, start: 'restart' })
    if (kind === 7 && roll(seed, step++) < 0.2) log.push({ id: 0, at, by: 'you', kind: 'event', text: `stopped ${worker}` })
  }
  const run = runOf(tasks, log)
  const all = IDS.slice(0, workers.length).map((id, index) => ({ ...run.workers[0], id, agent: { type: index % 2 ? OTHER_AGENT : WORKER_AGENT } }))
  return { ...run, workers: all, endedAt: roll(seed, step++) < 0.5 ? at + MIN : undefined }
}

test('a command takes the first class of the table: tests, builds, app, background, then tools', () => {
  expect(activityOf(BASH, 'bun test mcp/')).toBe('tests')
  expect(activityOf(BASH, 'cd web && npm run test -- --watch=false')).toBe('tests')
  expect(activityOf(BASH, 'python -m pytest -q')).toBe('tests')
  expect(activityOf(BASH, 'npx -y -p typescript@5.9 tsc -p tsconfig.core.json')).toBe('builds')
  expect(activityOf(BASH, 'npm install')).toBe('builds')
  expect(activityOf(BASH, 'cargo build --release')).toBe('builds')
  expect(activityOf(BASH, 'curl -s http://localhost:3000/health')).toBe('app')
  expect(activityOf(BASH, 'npm run dev')).toBe('app')
  expect(activityOf(BASH, 'tail -f server.log')).toBe('background')
  expect(activityOf(BASH, 'until test -f done; do sleep 2; done')).toBe('background')
  expect(activityOf(BASH, 'git log --oneline')).toBe('tools')
})

test('a command that matches two rules takes the first', () => {
  expect(activityOf(BASH, 'npm run build && npm test')).toBe('tests')
  expect(activityOf(BASH, 'until curl -s localhost:3000; do sleep 1; done')).toBe('app')
})

test('a description that names tests makes the command a test run', () => {
  expect(activityOf(BASH, './check.sh', 'Run the unit tests')).toBe('tests')
})

test('the board tools, the browser tools and the other tools have their own class', () => {
  expect(activityOf('mcp__meld__finish_task')).toBe('board')
  expect(activityOf('mcp__plugin_meld_board__read_board')).toBe('board')
  expect(activityOf('mcp__browser__navigate')).toBe('app')
  expect(activityOf('Read')).toBe('tools')
  expect(activityOf('Edit')).toBe('tools')
})

test('a lane shows work, a merge, a wait for a ready task, idle time, a sleep, an approval and a restart', () => {
  const [w1, w2] = lanesOf(storyRun(), NOW)
  expect(w1).toEqual({
    worker: 'w1',
    from: T0,
    to: NOW,
    parts: [
      { kind: 'working', from: T0, to: T0 + 10 * MIN, task: 1 },
      { kind: 'merging', from: T0 + 10 * MIN, to: T0 + 11 * MIN, task: 1 },
      { kind: 'waiting', from: T0 + 11 * MIN, to: T0 + 14 * MIN },
      { kind: 'idle', from: T0 + 14 * MIN, to: T0 + 20 * MIN },
      { kind: 'asleep', from: T0 + 20 * MIN, to: T0 + 30 * MIN },
      { kind: 'idle', from: T0 + 30 * MIN, to: NOW },
    ],
  })
  expect(w2.parts).toEqual([
    { kind: 'idle', from: T0, to: T0 + 10 * MIN },
    { kind: 'waiting', from: T0 + 10 * MIN, to: T0 + 14 * MIN },
    { kind: 'working', from: T0 + 14 * MIN, to: T0 + 20 * MIN, task: 2 },
    { kind: 'asleep', from: T0 + 20 * MIN, to: T0 + 30 * MIN },
    { kind: 'waiting', from: T0 + 30 * MIN, to: T0 + 32 * MIN, task: 2, reason: 'approval' },
    { kind: 'working', from: T0 + 32 * MIN, to: T0 + 36 * MIN, task: 2 },
    { kind: 'waiting', from: T0 + 36 * MIN, to: T0 + 38 * MIN, task: 2, reason: 'restart' },
    { kind: 'working', from: T0 + 38 * MIN, to: NOW, task: 2 },
  ])
})

test('a claim that the trimmed log lost comes from the task, and a stopped worker has a lane to its stop', () => {
  const tasks: Task[] = [{ id: 1, title: TITLE, detail: '', state: 'done', owner: 'w1', version: 3, addedAt: T0, readyAt: T0, claimedAt: T0 + MIN, doneAt: T0 + 5 * MIN, commit: COMMIT }]
  const log = [{ at: T0 + 8 * MIN, by: 'you', kind: 'event', text: 'stopped w2' }] as Entry[]
  const [w1, w2] = lanesOf(runOf(tasks, log), T0 + 10 * MIN)
  expect(w1.parts).toEqual([
    { kind: 'waiting', from: T0, to: T0 + MIN },
    { kind: 'working', from: T0 + MIN, to: T0 + 5 * MIN, task: 1 },
    { kind: 'idle', from: T0 + 5 * MIN, to: T0 + 10 * MIN },
  ])
  expect(w2).toEqual({
    worker: 'w2',
    from: T0,
    to: T0 + 8 * MIN,
    parts: [
      { kind: 'waiting', from: T0, to: T0 + MIN },
      { kind: 'idle', from: T0 + MIN, to: T0 + 8 * MIN },
    ],
  })
})

test('the parts of each lane of a random run join end to end and add up to the worker time', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const run = randomRun(seed)
    const now = run.endedAt ?? T0 + 2 * EVENTS * MIN
    const lanes = lanesOf(run, now)
    expect({ seed, lanes: lanes.length }).toEqual({ seed, lanes: run.workers.length })
    for (const lane of lanes) {
      const breaks = lane.parts.filter((part, index) => part.to <= part.from || part.from !== (lane.parts[index - 1]?.to ?? lane.from))
      const repeats = lane.parts.filter((part, index) => index > 0 && JSON.stringify({ ...part, from: 0, to: 0 }) === JSON.stringify({ ...lane.parts[index - 1], from: 0, to: 0 }))
      const sum = lane.parts.reduce((total, part) => total + part.to - part.from, 0)
      expect({ seed, worker: lane.worker, breaks, repeats, sum, end: lane.parts.at(-1)?.to ?? lane.to }).toEqual({ seed, worker: lane.worker, breaks: [], repeats: [], sum: lane.to - lane.from, end: lane.to })
      expect({ seed, inRun: lane.from >= run.startedAt && lane.to <= now }).toEqual({ seed, inRun: true })
    }
    const efficiency = efficiencyOf(run, now)
    expect({ seed, workerMs: efficiency.workerMs }).toEqual({ seed, workerMs: lanes.reduce((total, lane) => total + lane.to - lane.from, 0) })
    expect({ seed, share: efficiency.busyShare >= 0 && efficiency.busyShare <= 1 }).toEqual({ seed, share: true })
  }
})

test('the efficiency gives busy time, waits on meld, the time of one agent alone, sleep, restarts, rework, cost and context', () => {
  const efficiency = efficiencyOf(storyRun(), NOW)
  expect(efficiency).toMatchObject({
    runMs: 40 * MIN,
    workerMs: 80 * MIN,
    busyMs: 23 * MIN,
    busyShare: 23 / 80,
    parallelism: 23 / 40,
    waitingMs: 4 * MIN,
    aloneMs: 23 * MIN,
    asleepMs: 10 * MIN,
    idleRestarts: 1,
    checks: 2,
    failedChecks: 1,
    rework: 2,
    costUnits: 10_000,
    costPerTask: 10_000,
    cacheReadShare: 1000 / 7000,
  })
  expect(efficiency.workers[0]).toEqual({
    worker: 'w1',
    workerMs: 40 * MIN,
    busyMs: 11 * MIN,
    costUnits: 7000,
    largestContext: 120_000,
    meanContext: 1300,
    times: { model: 5 * MIN, tests: 2 * MIN, merge: MIN, waiting: 3 * MIN, idle: 16 * MIN, asleep: 10 * MIN },
  })
  expect(efficiency.workers[1]).toMatchObject({ worker: 'w2', busyMs: 12 * MIN, costUnits: 3000, times: { merge: 0, waiting: 8 * MIN, idle: 10 * MIN, asleep: 10 * MIN } })
})

test('cost units weigh the tokens by their price', () => {
  expect(costUnits({ input: 100, cacheWrite: 100, cacheRead: 100, output: 100 })).toBe(100 + 125 + 10 + 500)
})

test('the progress gives counts and weight over leaves, the ready time with no agent, scope growth, rate, the critical path and the blocked tasks', () => {
  expect(progressOf(storyRun(), NOW)).toEqual({
    done: 1,
    working: 1,
    ready: 0,
    waiting: 1,
    doneWeight: 3,
    allWeight: 5,
    readyNoAgent: { now: 0, ms: 4 * MIN },
    scopeGrowth: 0.5,
    rate: 0,
    criticalPath: { tasks: 2, weight: 2 },
    blocked: { count: 1, top: 2, blocks: 1 },
    taskMs: 10 * MIN,
  })
})

test('a parent leads the critical path through its parts, and the rate counts the weight done in the last 10 minutes', () => {
  const tasks: Task[] = [
    { id: 1, title: TITLE, detail: '', state: 'open', version: 1, size: 'L', addedAt: T0 },
    { id: 2, title: TITLE, detail: '', state: 'done', version: 2, size: 'L', parent: 1, addedAt: T0, doneAt: NOW - 5 * MIN },
    { id: 3, title: TITLE, detail: '', state: 'open', version: 1, size: 'M', parent: 1, addedAt: T0 },
    { id: 4, title: TITLE, detail: '', state: 'open', version: 1, size: 'S', needs: [1], addedAt: T0 },
  ]
  expect(progressOf(runOf(tasks, []), NOW)).toMatchObject({ done: 1, ready: 1, waiting: 1, doneWeight: 8, allWeight: 12, rate: 8, criticalPath: { tasks: 2, weight: 4 }, blocked: { count: 1, top: 1, blocks: 1 } })
})

test('the collaboration gives cross needs, handovers used, taken commits, splits for others, conflicts, overlap and steers', () => {
  const story = storyRun()
  expect(collaborationOf(story, NOW)).toEqual({ crossNeeds: 1, withNeeds: 1, handoversUsed: 1, commitsTaken: 2, splitsForOthers: 0, conflicts: 0, overlap: [], steers: 0, steersForMeld: 0 })
  const tasks: Task[] = [
    { id: 1, title: TITLE, detail: '', state: 'open', version: 2, addedAt: T0 },
    { id: 2, title: TITLE, detail: '', state: 'done', owner: 'w1', version: 2, parent: 1, addedAt: T0 },
    { id: 3, title: TITLE, detail: '', state: 'claimed', owner: 'w2', version: 2, parent: 1, addedAt: T0 },
    { id: 4, title: TITLE, detail: '', state: 'open', version: 1, integrates: 2, addedAt: T0 },
  ]
  const log = [
    { at: T0, by: 'w1', kind: 'task', text: 'split #1 into #2 Theme; #3 Toggle, and claimed #2' },
    { at: T0 + MIN, by: 'you', kind: 'merge', text: '', worker: 'w1', task: 2, from: T0, files: [FILE_A, FILE_B] },
    { at: T0 + 2 * MIN, by: 'you', kind: 'merge', text: '', worker: 'w2', task: 3, from: T0 + MIN, files: [FILE_B] },
    { at: T0 + 3 * MIN, by: 'you', kind: 'steer', text: 'Start the idle workers' },
    { at: T0 + 4 * MIN, by: 'you', kind: 'steer', text: 'Use a blue theme' },
  ] as Entry[]
  expect(collaborationOf(runOf(tasks, log), NOW)).toMatchObject({ splitsForOthers: 1, conflicts: 1, overlap: [FILE_B], steers: 2, steersForMeld: 1 })
})

test('the shared context gives entries by kind, deliveries, the time to delivery, citations, heeded fails and repeated fails', () => {
  const tasks: Task[] = [
    { id: 1, title: TITLE, detail: '', state: 'done', owner: 'w1', version: 2, addedAt: T0, used: [] },
    { id: 2, title: TITLE, detail: '', state: 'done', owner: 'w2', version: 2, addedAt: T0, used: [1, 4] },
  ]
  const context = [
    { id: 1, at: T0 + 2 * MIN, kind: 'fact' as const, by: 'w1' as const, text: SUMMARY, files: [], seenBy: ['w2' as const] },
    { id: 2, at: T0 + 3 * MIN, kind: 'fail' as const, by: 'w1' as const, text: SUMMARY, files: [FILE_A], seenBy: ['w2' as const] },
    { id: 3, at: T0 + 8 * MIN, kind: 'fail' as const, by: 'w2' as const, text: SUMMARY, files: [FILE_A, FILE_B], seenBy: [] },
    { id: 4, at: T0 + 9 * MIN, kind: 'interface' as const, by: 'w2' as const, text: SUMMARY, files: [], seenBy: [] },
  ]
  const log = [
    { at: T0 + 4 * MIN, by: 'you', kind: 'delivered', text: '', worker: 'w2', context: 1 },
    { at: T0 + 5 * MIN, by: 'you', kind: 'delivered', text: '', worker: 'w2', context: 2 },
  ] as Entry[]
  expect(sharedContextOf(runOf(tasks, log, { context }), NOW)).toEqual({
    entries: { fact: 1, fail: 2, interface: 1 },
    perTask: 2,
    delivered: 2,
    all: 4,
    deliveryMs: 2 * MIN,
    cited: 1,
    received: 2,
    workers: [
      { worker: 'w1', cited: 0, received: 0 },
      { worker: 'w2', cited: 1, received: 2 },
    ],
    failsHeeded: 0,
    failsReceived: 1,
    repeatedFails: 1,
  })
})

test('the workload gives the share of work, balance, spread, the largest task, idle time while others work and the agent mix', () => {
  expect(workloadOf(storyRun(), NOW)).toEqual({
    shares: [
      { worker: 'w1', share: 1 },
      { worker: 'w2', share: 0 },
    ],
    balance: 11.5 / 12,
    spread: 0.5 / 11.5,
    largestTaskShare: 3 / 5,
    idleWhileOthersWork: [
      { worker: 'w1', ms: 12 * MIN },
      { worker: 'w2', ms: 11 * MIN },
    ],
    agentMix: [
      { type: WORKER_AGENT, share: 1, rework: 1 },
      { type: OTHER_AGENT, share: 0, rework: 0 },
    ],
  })
})
