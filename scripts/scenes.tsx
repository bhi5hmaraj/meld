// The sample runs of the README pictures. scripts/shots.mjs runs this file as a test, reads the trees it prints, and
// draws them. Each scene builds its run with the board functions, so the pictures follow the real pane.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { addCheck, addNote, addTasks, bindWorker, boardFor, claimTask, declareFinal, finishTask, isFailure, setActivity, setSaid, setWorkerState, shareEntry, splitTask, startRun, steer, takeIntegration } from '../core/board'
import type { Change, CommitFact, Facts, FileChange, PaneView, Run, WorkerId } from '../types'

declare const console: { log: (line: string) => void }

const NOW = 1_800_000_000_000
const MINUTE = 60_000
const BASE = 'a'.repeat(40)
const FINAL = 'b6e2f10'
const REQUEST = 'Add a dark theme with a toggle in the header'
const WORKERS: WorkerId[] = ['w1', 'w2', 'w3']
const LANES: Record<string, { commits: string[]; subject: string }> = {
  w1: { commits: ['1f3a9c2', '7be41d0', 'c08d5e1'], subject: 'Colour tokens' },
  w2: { commits: ['4d92e7a', '9a1c3f8'], subject: 'Toggle in the header' },
  w3: { commits: ['e5b0a64', '2c7f9d3'], subject: 'Spacing tokens' },
}
const PANE = {
  plugin: 'meld',
  component: 'Pane',
  requestId: 'meld',
  surface: 'desktop',
  props: { title: 'meld', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const
const START_VIEW: PaneView = { showDiff: false, task: REQUEST, agents: 3, model: 'sonnet', vcs: 'auto' }
const WORKING_VIEW: PaneView = { ...START_VIEW, task: '', open: [1] }
const READY_VIEW: PaneView = { ...START_VIEW, task: '' }
const USAGE = { startedAt: NOW - 30 * MINUTE, context: { window: 200_000 }, rateLimits: [], cost: { usd: 3.85 } }
const FILES: FileChange[] = [
  { path: 'src/theme.css', added: 48, removed: 2, patch: '@@ -1,3 +1,9 @@\n :root {\n-  --bg: #fff;\n+  --bg: #ffffff;\n+  --text: #1f1e1d;\n+}\n+[data-theme="dark"] {\n+  --bg: #1f1e1d;\n+  --text: #ecebe6;\n }' },
  { path: 'src/header.tsx', added: 31, removed: 6, patch: '' },
]

type Stored = { value: unknown; version: number }

function full(short: string): string {
  return short.padEnd(40, '0')
}

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

function started(): Run {
  const workers = WORKERS.map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: `${id}@`, agent: { type: 'meld:worker', model: 'sonnet' } }))
  const run = startRun({ id: 'r1', request: REQUEST, repo: '/repo', base: BASE, vcs: 'jj', now: NOW - 14 * MINUTE, costAtStart: 1.35, workers })
  return WORKERS.reduce((current, id, index) => runOf(bindWorker(current, id, `agent-${index + 1}`, NOW - 14 * MINUTE)), run)
}

/** w1 splits #1 into colours and spacing and finishes colours; w2 builds the toggle; w3 takes spacing; w1 takes the contrast check; the docs wait for #1. */
function planned(): Run {
  const tasks = [
    { title: 'Theme tokens', size: 'L' as const },
    { title: 'Toggle in the header' },
    { title: 'Docs for the theme', size: 'S' as const, needs: [1] },
    { title: 'Contrast check', size: 'S' as const },
  ]
  let run = runOf(addTasks(started(), 'w1', { seen: 0, tasks }, NOW - 13 * MINUTE))
  run = runOf(claimTask(run, 'w1', 1, 1, NOW - 13 * MINUTE))
  run = runOf(claimTask(run, 'w2', 2, 1, NOW - 13 * MINUTE))
  run = runOf(splitTask(run, 'w1', { task: 1, version: 2, seen: 1, tasks: [{ title: 'Colour tokens' }, { title: 'Spacing tokens', size: 'S' }] }, NOW - 12 * MINUTE))
  run = runOf(claimTask(run, 'w3', 6, 1, NOW - 11 * MINUTE))
  run = runOf(finishTask(run, 'w1', 5, 1, full(LANES.w1!.commits[0]!), 'Colour tokens in theme.css', NOW - 6 * MINUTE))
  return runOf(claimTask(run, 'w1', 4, 1, NOW - 5 * MINUTE))
}

function shared(run: Run): Run {
  const entries = [
    { by: 'w1' as const, kind: 'fact', text: 'The colours live in src/theme.css as CSS variables.' },
    { by: 'w2' as const, kind: 'fail', text: 'A global dark stylesheet breaks the old pages: they set colours inline.' },
    { by: 'w3' as const, kind: 'interface', text: "useTheme(): 'light' | 'dark' reads the stored theme." },
  ]
  const added = entries.reduce((current, entry) => runOf(shareEntry(current, entry.by, { kind: entry.kind, text: entry.text }, NOW - 5 * MINUTE)), run)
  return WORKERS.reduce((current, id) => boardFor(current, id, NOW).run, added)
}

function checked(run: Run): Run {
  const checks = [
    { by: 'w1' as const, command: 'pnpm test', commit: LANES.w1!.commits[0]!, passed: true },
    { by: 'w2' as const, command: 'pnpm lint', commit: LANES.w2!.commits[0]!, passed: false },
    { by: 'w3' as const, command: 'pnpm build', commit: LANES.w3!.commits[0]!, passed: true },
  ]
  return checks.reduce((current, check) => runOf(addCheck(current, check.by, { command: check.command, commit: full(check.commit), passed: check.passed, output: '' }, NOW - 3 * MINUTE)), run)
}

function busy(run: Run): Run {
  const activities = [
    { id: 'w1' as const, text: 'Bash: pnpm test', at: NOW - 8_000, calls: 42 },
    { id: 'w2' as const, text: 'Edit src/header.tsx', at: NOW - 40_000, calls: 37 },
    { id: 'w3' as const, text: 'Read src/theme.css', at: NOW - 150_000, calls: 29 },
  ]
  const active = activities.reduce((current, one) => setActivity(current, one.id, one.text, one.at), run)
  return { ...active, workers: active.workers.map(worker => ({ ...worker, calls: activities.find(one => one.id === worker.id)?.calls ?? 0 })) }
}

/** The notes of the agents and one steer of the person, for the Conversation section. */
function talked(run: Run): Run {
  let talking = runOf(addNote(run, 'w1', 'The colour tokens are in src/theme.css. Use var(--surface), not a hex value.', undefined, NOW - 6 * MINUTE))
  talking = runOf(steer(talking, 'Keep the old light theme as the default.', NOW - 4 * MINUTE))
  return runOf(addNote(talking, 'w2', 'Agreed. The toggle starts in the light theme.', undefined, NOW - 3 * MINUTE))
}

/** w2 wrote a sentence a moment ago, so its card shows its own words. */
function working(): Run {
  return setSaid(busy(checked(talked(shared(planned())))), 'w2', 'Adding the toggle to the header, next to the search box.', NOW - 20_000)
}

function ready(): Run {
  let run = working()
  run = runOf(finishTask(run, 'w3', 6, 2, full(LANES.w3!.commits[1]!), 'Spacing tokens', NOW - 3 * MINUTE))
  run = runOf(finishTask(run, 'w2', 2, 2, full(LANES.w2!.commits[1]!), 'Toggle in the header', NOW - 3 * MINUTE))
  run = runOf(finishTask(run, 'w1', 4, 2, full(LANES.w1!.commits[1]!), 'Contrast check', NOW - 3 * MINUTE))
  run = runOf(claimTask(run, 'w1', 3, 1, NOW - 3 * MINUTE))
  run = runOf(finishTask(run, 'w1', 3, 2, full(LANES.w1!.commits[2]!), 'Docs for the theme', NOW - 2 * MINUTE))
  run = runOf(takeIntegration(run, 'w2', NOW - 2 * MINUTE))
  for (const command of ['pnpm test', 'pnpm lint', 'pnpm build']) run = runOf(addCheck(run, 'w2', { command, commit: full(FINAL), passed: true, output: '' }, NOW - MINUTE))
  run = runOf(declareFinal(run, 'w2', full(FINAL), 'Adds a dark theme: colour and spacing tokens, a toggle in the header, docs and a contrast check.', NOW - 30_000))
  return WORKERS.reduce((current, id) => setWorkerState(current, id, 'idle', NOW - 30_000), run)
}

function laneCommits(id: WorkerId): CommitFact[] {
  const lane = LANES[id]
  if (!lane) return []
  return lane.commits.map((short, index) => ({ commit: full(short), subject: `${lane.subject} ${index + 1}`, parents: id === 'w3' && index === 1 ? 2 : 1, conflict: false })).reverse()
}

/** The commits of each lane, newest first; in a ready run, w2 holds the final merge. */
function factsOf(run: Run): Facts {
  const integrated = run.final !== undefined
  const lanes = run.workers.map(worker => {
    const own = laneCommits(worker.id)
    const commits = integrated && worker.id === 'w2' ? [{ commit: full(FINAL), subject: 'meld: integrate', parents: 3, conflict: false }, ...own] : own
    return { id: worker.id, commits, edits: !integrated && worker.id === 'w2' }
  })
  return integrated ? { run: run.id, lanes, result: { commit: full(FINAL), files: FILES, fileCount: 7, added: 214, removed: 38 } } : { run: run.id, lanes }
}

function stored(run: Run | null, view: PaneView): Map<string, Stored> {
  const values = new Map<string, Stored>()
  if (run) values.set('run', { value: { shape: 'run-4', value: run }, version: 1 })
  if (run) values.set('facts', { value: { shape: 'facts-1', value: factsOf(run) }, version: 1 })
  values.set('view', { value: { shape: 'view-1', value: view }, version: 1 })
  return values
}

async function print($: Engine, scene: string): Promise<void> {
  const ui = await $.ui.mount(PANE)
  const tree = await ui.drawn()
  console.log(`SCENE ${JSON.stringify({ scene, tree })}`)
  expect(tree).toBeDefined()
  await ui.unmount()
}

test('scene: the start form', async ($, on) => {
  const values = stored(null, START_VIEW)
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: values.get(e.key) ?? { value: undefined, version: 0 } }))
  await print($, 'start')
})

test('scene: a run at work', async ($, on) => {
  const values = stored(working(), WORKING_VIEW)
  on('clock.now', () => ({ value: NOW }))
  on('session.usage', () => ({ value: USAGE }))
  on('state.get', ($, e) => ({ value: values.get(e.key) ?? { value: undefined, version: 0 } }))
  await print($, 'working')
})

test('scene: a run ready to deliver', async ($, on) => {
  const values = stored(ready(), READY_VIEW)
  on('clock.now', () => ({ value: NOW }))
  on('session.usage', () => ({ value: USAGE }))
  on('state.get', ($, e) => ({ value: values.get(e.key) ?? { value: undefined, version: 0 } }))
  await print($, 'ready')
})
