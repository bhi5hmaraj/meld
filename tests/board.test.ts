import { expect, test } from 'claude-code/testing'

import {
  addCheck,
  addNote,
  addTasks,
  addTokens,
  bindWorker,
  boardFor,
  claimTask,
  CONTEXT_TEXT_LIMIT,
  countCall,
  countNudge,
  currentContext,
  declareFinal,
  finishTask,
  isFailure,
  markBriefed,
  passContext,
  releaseTask,
  restartWorker,
  shareEntry,
  SPLIT_CALLS,
  splitTask,
  startRun,
  steer,
  stopRun,
  stopWorker,
  takeIntegration,
  takeNotice,
  takeSplitNudge,
  workerOf,
} from '../hooks/board'
import type { Change, NewTask, Run, TaskSize, WorkerId } from '../types'
import { STORED_BY_0_6_0, STORED_BY_0_7_0 } from './stored-runs'

const NOW = 1_800_000_000_000
const AGENT = { type: 'meld:worker' }
const IDS: WorkerId[] = ['w1', 'w2', 'w3']

function fresh(count = 2): Run {
  const workers = IDS.slice(0, count).map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: `meld/r1/${id}`, agent: AGENT }))
  return startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: 'abc1234', vcs: 'git', now: NOW, workers })
}

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

function working(): Run {
  return runOf(bindWorker(runOf(bindWorker(fresh(), 'w1', 'agent-1', NOW)), 'w2', 'agent-2', NOW))
}

function workingThree(): Run {
  const two = runOf(bindWorker(runOf(bindWorker(fresh(3), 'w1', 'agent-1', NOW)), 'w2', 'agent-2', NOW))
  return runOf(bindWorker(two, 'w3', 'agent-3', NOW))
}

function withTask(): Run {
  return runOf(addTasks(working(), 'w1', { seen: 0, tasks: [{ title: 'Theme tokens', detail: 'CSS variables' }] }, NOW))
}

/** Tokens, then a large toggle that needs them, with a part for its docs. */
function planned(): Run {
  const tasks: NewTask[] = [{ title: 'Theme tokens', size: 'S' }, { title: 'Dark toggle', size: 'L', needs: [1] }, { title: 'Toggle docs', parent: 2 }]
  return runOf(addTasks(working(), 'w1', { seen: 0, tasks }, NOW))
}

function withTokensDone(at: number): Run {
  const claimed = runOf(claimTask(planned(), 'w1', 1, 1, NOW))
  return runOf(finishTask(claimed, 'w1', 1, 2, 'def5678', 'Tokens added', at))
}

const PARTS: NewTask[] = [{ title: 'Colour tokens', size: 'S' }, { title: 'Spacing tokens' }, { title: 'Token docs', needs: [3] }]

/** #1 split by w1 into #2, which w1 keeps, and the open #3 and #4; #4 needs #3. */
function splitRun(): Run {
  return runOf(splitTask(runOf(claimTask(withTask(), 'w1', 1, 1, NOW)), 'w1', { task: 1, version: 2, seen: 1, tasks: PARTS }, NOW + 1))
}

/** Finishes the parts of the split: #2 at NOW + 2, #3 at NOW + 4 and #4 at NOW + 6. */
function withPartsDone(run = splitRun()): Run {
  const second = runOf(finishTask(run, 'w1', 2, 1, 'aaa1111', 'Colours added', NOW + 2))
  const third = runOf(finishTask(runOf(claimTask(second, 'w2', 3, 1, NOW + 3)), 'w2', 3, 2, 'bbb2222', 'Spacing added', NOW + 4))
  return runOf(finishTask(runOf(claimTask(third, 'w2', 4, 1, NOW + 5)), 'w2', 4, 2, 'ccc3333', 'Docs added', NOW + 6))
}

function messageOf<T>(change: Change<T>): string {
  return isFailure(change) ? change.message : ''
}

function withFacts(count: number): Run {
  let run = working()
  for (let index = 1; index <= count; index++) run = runOf(shareEntry(run, 'w1', { kind: 'fact', text: `Fact ${index}` }, NOW))
  return run
}

test('a new run waits for its workers', () => {
  const run = fresh()
  expect(run.state).toBe('starting')
  expect(run.revision).toBe(1)
  expect(run.workers.map(worker => worker.id)).toEqual(['w1', 'w2'])
})

test('a run works once both workers are bound', () => {
  const run = working()
  expect(run.state).toBe('working')
  expect(workerOf(run, 'agent-2')?.id).toBe('w2')
})

test('a run of three workers waits for the third binding', () => {
  const two = runOf(bindWorker(runOf(bindWorker(fresh(3), 'w1', 'agent-1', NOW)), 'w2', 'agent-2', NOW))
  expect(two.state).toBe('starting')
  expect(workingThree().state).toBe('working')
})

test('the board shows every other worker as a peer', () => {
  const view = boardFor(workingThree(), 'w2').view
  expect(view.peers.map(peer => peer.id)).toEqual(['w1', 'w3'])
  expect(view.you).toEqual({ id: 'w2', path: '/tmp/meld/r1/w2', ref: 'meld/r1/w2' })
  expect(view.vcs).toBe('git')
})

test('a bound worker cannot be bound again', () => {
  expect(bindWorker(working(), 'w1', 'agent-3', NOW)).toMatchObject({ error: 'TAKEN' })
})

test('a worker is briefed once', () => {
  const run = working()
  expect(run.workers[0]?.briefed).toBe(false)
  expect(markBriefed(run, 'w1').workers[0]?.briefed).toBe(true)
})

test('the tokens of each turn add up for the worker', () => {
  const run = addTokens(addTokens(working(), 'w2', 1200), 'w2', 300)
  expect(run.workers.map(worker => worker.tokens)).toEqual([0, 1500])
})

test('a tool call of a worker adds one to the calls of each task it claimed', () => {
  const run = countCall(countCall(runOf(claimTask(withTask(), 'w2', 1, 1, NOW)), 'w2'), 'w1')
  expect(run.tasks[0]?.calls).toBe(1)
  expect(run.workers.map(worker => worker.calls)).toEqual([1, 1])
})

test('an open task counts no calls', () => {
  expect(countCall(withTask(), 'w2').tasks[0]?.calls).toBeUndefined()
})

/** The tool calls of its owner after which a leaf of this size earns its nudge, or 0 when none comes in 200 calls. */
function callsToNudge(size?: TaskSize): number {
  const added = runOf(addTasks(working(), 'w1', { seen: 0, tasks: [{ title: 'Theme tokens', size }] }, NOW))
  let run = runOf(claimTask(added, 'w2', 1, 1, NOW))
  for (let calls = 1; calls <= 200; calls++) {
    run = countCall(run, 'w2')
    if (takeSplitNudge(run, 'w2').task) return calls
  }
  return 0
}

test('the nudge limit of a leaf goes by its size: S 30, M 60 and L 120 tool calls', () => {
  expect(SPLIT_CALLS).toEqual({ S: 30, M: 60, L: 120 })
  expect([callsToNudge('S'), callsToNudge('M'), callsToNudge('L')]).toEqual([30, 60, 120])
})

test('a leaf with no size has the nudge limit of an M task', () => {
  expect(callsToNudge()).toBe(60)
})

test('a leaf with 60 calls of its owner and no size earns one nudge', () => {
  let run = runOf(claimTask(withTask(), 'w2', 1, 1, NOW))
  for (let call = 0; call < SPLIT_CALLS.M; call++) run = countCall(run, 'w2')
  const nudge = takeSplitNudge(run, 'w2')
  expect(nudge.task).toMatchObject({ id: 1, calls: 60, nudged: true })
  expect(takeSplitNudge(nudge.run, 'w2').task).toBeUndefined()
})

test('a leaf with 59 calls of its owner and no size earns no nudge', () => {
  let run = runOf(claimTask(withTask(), 'w2', 1, 1, NOW))
  for (let call = 1; call < SPLIT_CALLS.M; call++) run = countCall(run, 'w2')
  expect(takeSplitNudge(run, 'w2').task).toBeUndefined()
})

test('the nudge of a leaf goes to its owner and to no other worker', () => {
  let run = runOf(claimTask(withTask(), 'w2', 1, 1, NOW))
  for (let call = 0; call < SPLIT_CALLS.M; call++) run = countCall(run, 'w2')
  expect(takeSplitNudge(run, 'w1').task).toBeUndefined()
})

test('a leaf of a run that meld 0.7.0 or older stored, with no size, earns its nudge at 60 calls of its owner', () => {
  let run = STORED_BY_0_6_0
  for (let call = 1; call < SPLIT_CALLS.M; call++) run = countCall(run, 'w1')
  expect(takeSplitNudge(run, 'w1').task).toBeUndefined()
  expect(takeSplitNudge(countCall(run, 'w1'), 'w1').task).toMatchObject({ id: 2, calls: 60, nudged: true })
})

test('a finished task counts no more calls', () => {
  const claimed = countCall(runOf(claimTask(withTask(), 'w2', 1, 1, NOW)), 'w2')
  const done = runOf(finishTask(claimed, 'w2', 1, 2, 'abc1234', 'Tokens', NOW))
  expect(countCall(done, 'w2').tasks[0]?.calls).toBe(1)
})

test('a new claim of a released task counts its calls from zero', () => {
  const claimed = countCall(runOf(claimTask(withTask(), 'w2', 1, 1, NOW)), 'w2')
  const released = runOf(releaseTask(claimed, 'w2', 1, 2, '', NOW))
  expect(runOf(claimTask(released, 'w1', 1, 3, NOW)).tasks[0]?.calls).toBe(0)
})

test('a worker claims an open task', () => {
  const run = runOf(claimTask(withTask(), 'w2', 1, 1, NOW))
  expect(run.tasks[0]).toMatchObject({ state: 'claimed', owner: 'w2', version: 2 })
})

test('a claimed task refuses the other worker', () => {
  const run = runOf(claimTask(withTask(), 'w2', 1, 1, NOW))
  expect(claimTask(run, 'w1', 1, 2, NOW)).toMatchObject({ error: 'TAKEN' })
})

test('a claim with an old version is stale', () => {
  const run = runOf(claimTask(withTask(), 'w2', 1, 1, NOW))
  expect(claimTask(run, 'w2', 1, 1, NOW)).toMatchObject({ error: 'STALE_VERSION' })
})

test('only the owner finishes a task, with its commit', () => {
  const run = runOf(claimTask(withTask(), 'w1', 1, 1, NOW))
  expect(finishTask(run, 'w2', 1, 2, 'def5678', 'Tokens added', NOW)).toMatchObject({ error: 'NOT_OWNER' })
  expect(runOf(finishTask(run, 'w1', 1, 2, 'def5678', 'Tokens added', NOW)).tasks[0]).toMatchObject({ state: 'done', commit: 'def5678' })
})

test('a finished task gives the run its restarts again', () => {
  const stuck = countNudge(countNudge(runOf(claimTask(withTask(), 'w1', 1, 1, NOW))))
  expect(runOf(finishTask(stuck, 'w1', 1, 2, 'def5678', 'Tokens added', NOW)).nudges).toBe(0)
})

test('a released task is open again', () => {
  const run = runOf(claimTask(withTask(), 'w1', 1, 1, NOW))
  const released = runOf(releaseTask(run, 'w1', 1, 2, 'Half done on meld/r1/w1', NOW))
  expect(released.tasks[0]).toMatchObject({ state: 'open', version: 3 })
  expect(released.tasks[0]?.owner).toBeUndefined()
})

test('a steer raises the revision and each worker sees it once', () => {
  const steered = runOf(steer(working(), 'Use the brand colours', NOW))
  expect(steered.revision).toBe(2)
  const first = boardFor(steered, 'w1')
  expect(first.view.notice?.steers).toEqual(['Use the brand colours'])
  expect(boardFor(first.run, 'w1').view.notice).toBeUndefined()
})

test('a worker that has not read a steer still claims work and the run keeps working', () => {
  const steered = runOf(steer(withTask(), 'Use the brand colours', NOW))
  const run = runOf(claimTask(steered, 'w1', 1, 1, NOW))
  expect(run.tasks[0]).toMatchObject({ state: 'claimed', owner: 'w1' })
  expect(run.state).toBe('working')
})

test('one worker integrates at a time', () => {
  const run = runOf(takeIntegration(working(), 'w2', NOW))
  expect(run.integrator).toBe('w2')
  expect(takeIntegration(run, 'w1', NOW)).toMatchObject({ error: 'INTEGRATION_TAKEN' })
})

test('the integrator declares the final commit and the run is ready', () => {
  const run = runOf(takeIntegration(working(), 'w2', NOW))
  expect(declareFinal(run, 'w1', 'fff0000', 'All done', NOW)).toMatchObject({ error: 'NOT_INTEGRATOR' })
  const ready = runOf(declareFinal(run, 'w2', 'fff0000', 'All done', NOW))
  expect(ready.state).toBe('ready')
  expect(ready.final).toEqual({ commit: 'fff0000', summary: 'All done', by: 'w2' })
})

test('a stopped run refuses work but still shows its board', () => {
  const stopped = stopRun(withTask(), NOW)
  expect(stopped.workers.map(worker => worker.state)).toEqual(['stopped', 'stopped'])
  expect(claimTask(stopped, 'w1', 1, 1, NOW)).toMatchObject({ error: 'RUN_ENDED' })
  expect(boardFor(stopped, 'w1').view.state).toBe('stopped')
})

test('a steer of a stopped run is refused', () => {
  expect(steer(stopRun(working(), NOW), 'More', NOW)).toMatchObject({ error: 'RUN_ENDED' })
})

test('a steer of a ready run whose line meld moved to the final commit asks for changes and the run works again', () => {
  const integrating = runOf(takeIntegration(working(), 'w2', NOW))
  const ready = runOf(declareFinal(integrating, 'w2', 'fff0000', 'All done', NOW))
  const changed = runOf(steer(ready, 'Rename the toggle', NOW, 'fff0000'))
  expect(changed.state).toBe('working')
  expect(changed.final).toBeUndefined()
  expect(changed.integrator).toBe('w2')
})

test('a tool reply carries a new steer once and leaves the news unread', () => {
  const noted = runOf(addNote(working(), 'w1', 'The theme lives in theme.css', undefined, NOW))
  const steered = runOf(steer(noted, 'Use the brand colours', NOW))
  const taken = takeNotice(steered, 'w2')
  expect(taken.notice?.steers).toEqual(['Use the brand colours'])
  expect(takeNotice(taken.run, 'w2').notice).toBeUndefined()
  expect(boardFor(taken.run, 'w2').view.news.map(entry => entry.kind)).toEqual(['note'])
})

test('a stopped worker gives back its claimed tasks and the integration', () => {
  const claimed = runOf(claimTask(withTask(), 'w1', 1, 1, NOW))
  const integrating = runOf(takeIntegration(claimed, 'w1', NOW))
  const stopped = stopWorker(integrating, 'w1', NOW)
  expect(stopped.tasks[0]).toMatchObject({ state: 'open', version: 3 })
  expect(stopped.integrator).toBeUndefined()
  expect(stopped.workers[0]?.state).toBe('stopped')
  expect(stopped.state).toBe('working')
})

test('notes and checks of one worker are news for the other workers only', () => {
  const noted = runOf(addNote(workingThree(), 'w1', 'The theme lives in theme.css', undefined, NOW))
  const checked = runOf(addCheck(noted, 'w1', { command: 'pnpm test', commit: 'abc1234', passed: true, output: '' }, NOW))
  expect(boardFor(checked, 'w2').view.news.map(entry => entry.kind)).toEqual(['note', 'check'])
  expect(boardFor(checked, 'w3').view.news.map(entry => entry.kind)).toEqual(['note', 'check'])
  expect(boardFor(checked, 'w1').view.news).toHaveLength(0)
})

test('a worker adds a batch of tasks when it has seen the current task list', () => {
  const run = runOf(addTasks(working(), 'w1', { seen: 0, tasks: [{ title: 'Tokens' }, { title: 'Toggle' }] }, NOW))
  expect(run.tasks.map(task => task.title)).toEqual(['Tokens', 'Toggle'])
  expect(run.taskList).toBe(1)
})

test('an add from a worker that has not seen the newest tasks fails and shows them', () => {
  const run = runOf(addTasks(working(), 'w1', { seen: 0, tasks: [{ title: 'Tokens' }] }, NOW))
  expect(addTasks(run, 'w2', { seen: 0, tasks: [{ title: 'Theme tokens' }] }, NOW)).toMatchObject({
    error: 'STALE_TASK_LIST',
    taskList: 1,
    tasks: [{ id: 1, title: 'Tokens' }],
  })
})

test('after a board read the worker adds what is missing', () => {
  const run = runOf(addTasks(working(), 'w1', { seen: 0, tasks: [{ title: 'Tokens' }] }, NOW))
  const read = boardFor(run, 'w2')
  const added = runOf(addTasks(read.run, 'w2', { seen: read.view.taskList, tasks: [{ title: 'Docs' }] }, NOW))
  expect(added.tasks.map(task => task.title)).toEqual(['Tokens', 'Docs'])
})

test('a worker that adds again uses the version its last add returned', () => {
  const first = addTasks(working(), 'w1', { seen: 0, tasks: [{ title: 'Tokens' }] }, NOW)
  expect(first).toMatchObject({ value: { taskList: 1 } })
  expect(runOf(addTasks(runOf(first), 'w1', { seen: 1, tasks: [{ title: 'Docs' }] }, NOW)).taskList).toBe(2)
})

test('claims and finished tasks do not change the task list version', () => {
  const claimed = runOf(claimTask(withTask(), 'w1', 1, 1, NOW))
  const done = runOf(finishTask(claimed, 'w1', 1, 2, 'def5678', 'Tokens added', NOW))
  expect(done.taskList).toBe(1)
})

test('a new run has no shared context', () => {
  expect(fresh().context).toEqual([])
  expect(boardFor(working(), 'w1').view.context).toEqual([])
})

test('a shared entry keeps its kind, author, text, commit and files, and starts with no readers', () => {
  const shared = shareEntry(working(), 'w2', { kind: 'interface', text: 'toggleTheme(): void in theme.ts', commit: 'def5678', files: ['src/theme.ts'] }, NOW)
  expect(shared).toMatchObject({ value: { id: 1, kind: 'interface', by: 'w2', text: 'toggleTheme(): void in theme.ts', commit: 'def5678', files: ['src/theme.ts'], seenBy: [] } })
})

test('every worker sees the shared entries in its board read, newest first', () => {
  const first = runOf(shareEntry(working(), 'w1', { kind: 'fact', text: 'The theme lives in theme.css' }, NOW))
  const second = runOf(shareEntry(first, 'w2', { kind: 'fail', text: 'A CSS filter inverts the images' }, NOW))
  expect(boardFor(second, 'w1').view.context.map(entry => [entry.id, entry.by, entry.text])).toEqual([
    [2, 'w2', 'A CSS filter inverts the images'],
    [1, 'w1', 'The theme lives in theme.css'],
  ])
})

test('a board read shows an entry with its id, kind, author, text, commit, files and readers', () => {
  const shared = runOf(shareEntry(working(), 'w1', { kind: 'fact', text: 'The theme lives in theme.css', commit: 'def5678', files: ['src/theme.css'] }, NOW))
  const [entry] = JSON.parse(JSON.stringify(boardFor(shared, 'w2').view.context)) as object[]
  expect(Object.keys(entry ?? {}).sort()).toEqual(['by', 'commit', 'files', 'id', 'kind', 'seenBy', 'text'])
})

test('a share is news for the other workers', () => {
  const shared = runOf(shareEntry(working(), 'w1', { kind: 'fact', text: 'The theme lives in theme.css' }, NOW))
  expect(boardFor(shared, 'w2').view.news.map(entry => [entry.kind, entry.text])).toEqual([['share', 'shared fact 1']])
  expect(boardFor(shared, 'w1').view.news).toHaveLength(0)
})

test('an entry that a newer entry replaces is not current', () => {
  const first = runOf(shareEntry(working(), 'w1', { kind: 'fact', text: 'The theme lives in theme.css' }, NOW))
  const fixed = runOf(shareEntry(first, 'w2', { kind: 'fact', text: 'The theme lives in tokens.css', replaces: 1 }, NOW))
  expect(currentContext(fixed).map(entry => entry.id)).toEqual([2])
  expect(boardFor(fixed, 'w1').view.context.map(entry => entry.replaces)).toEqual([1])
})

test('a share that replaces an entry that does not exist is refused', () => {
  expect(shareEntry(working(), 'w1', { kind: 'fact', text: 'The theme lives in tokens.css', replaces: 4 }, NOW)).toMatchObject({ error: 'NOT_FOUND' })
})

test('the context holds the 20 newest current entries', () => {
  const context = currentContext(withFacts(25))
  expect(context).toHaveLength(20)
  expect(context[0]?.text).toBe('Fact 25')
  expect(context.at(-1)?.text).toBe('Fact 6')
})

test('a share with a kind other than fact, fail or interface is refused', () => {
  expect(shareEntry(working(), 'w1', { kind: 'idea', text: 'Use a CSS filter' }, NOW)).toMatchObject({ error: 'INVALID' })
})

test('a share with an empty text is refused', () => {
  expect(shareEntry(working(), 'w1', { kind: 'fact', text: '  ' }, NOW)).toMatchObject({ error: 'INVALID' })
})

test('a share holds at most 500 characters of text', () => {
  expect(CONTEXT_TEXT_LIMIT).toBe(500)
  expect(shareEntry(working(), 'w1', { kind: 'fact', text: 'a'.repeat(500) }, NOW)).toMatchObject({ value: { id: 1 } })
  expect(shareEntry(working(), 'w1', { kind: 'fact', text: 'a'.repeat(501) }, NOW)).toMatchObject({ error: 'INVALID' })
})

test('a stopped run refuses a share', () => {
  expect(shareEntry(stopRun(working(), NOW), 'w1', { kind: 'fact', text: 'The theme lives in theme.css' }, NOW)).toMatchObject({ error: 'RUN_ENDED' })
})

test('a board read adds its reader to seenBy of each entry one time, and does not add the author', () => {
  const shared = runOf(shareEntry(workingThree(), 'w1', { kind: 'fact', text: 'The theme lives in theme.css' }, NOW))
  const byAuthor = boardFor(shared, 'w1').run
  const twice = boardFor(boardFor(byAuthor, 'w2').run, 'w2')
  expect(twice.run.context?.[0]?.seenBy).toEqual(['w2'])
  expect(boardFor(twice.run, 'w3').run.context?.[0]?.seenBy).toEqual(['w2', 'w3'])
})

test('the context of any board reply counts its reader in seenBy', () => {
  const shared = runOf(shareEntry(working(), 'w1', { kind: 'fact', text: 'The theme lives in theme.css' }, NOW))
  const passed = passContext(shared, 'w2')
  expect(passed.context[0]?.seenBy).toEqual(['w2'])
  expect(passed.run.context?.[0]?.seenBy).toEqual(['w2'])
})

test('a read counts no reader for an entry that it does not show', () => {
  const read = passContext(withFacts(21), 'w2').run
  expect(read.context?.[0]?.seenBy).toEqual([])
  expect(read.context?.[1]?.seenBy).toEqual(['w2'])
})

test('a later reply carries only the entries that are new for its reader since its last reply', () => {
  const first = runOf(shareEntry(working(), 'w2', { kind: 'fact', text: 'The theme lives in theme.css' }, NOW))
  const read = boardFor(first, 'w1')
  expect(read.view.context.map(entry => entry.text)).toEqual(['The theme lives in theme.css'])
  const second = runOf(shareEntry(read.run, 'w2', { kind: 'fail', text: 'A CSS filter inverts the images' }, NOW))
  expect(boardFor(second, 'w1').view.context.map(entry => [entry.id, entry.text, entry.seenBy])).toEqual([[2, 'A CSS filter inverts the images', ['w1']]])
})

test('a reply carries no entry when nothing is new for its reader', () => {
  const read = passContext(runOf(shareEntry(working(), 'w2', { kind: 'fact', text: 'The theme lives in theme.css' }, NOW)), 'w1').run
  expect(passContext(read, 'w1').context).toEqual([])
  expect(boardFor(read, 'w1').view.context).toEqual([])
})

test('after its first reply, a reply carries no entry that its reader wrote', () => {
  const read = passContext(working(), 'w1').run
  const shared = runOf(shareEntry(read, 'w1', { kind: 'fact', text: 'The theme lives in theme.css' }, NOW))
  expect(passContext(shared, 'w1').context).toEqual([])
  expect(passContext(shared, 'w2').context.map(entry => entry.text)).toEqual(['The theme lives in theme.css'])
})

test('the first reply to an agent carries the current entries, 20 at most, its own entries too', () => {
  const first = passContext(withFacts(25), 'w1')
  expect(first.context).toHaveLength(20)
  expect([first.context[0]?.text, first.context.at(-1)?.text]).toEqual(['Fact 25', 'Fact 6'])
  expect(passContext(first.run, 'w1').context).toEqual([])
})

test('a stopped worker changes nothing on the board, as its agent can still call: each change fails with WORKER_STOPPED', () => {
  const stopped = stopWorker(withTask(), 'w2', NOW)
  expect(claimTask(stopped, 'w2', 1, 1, NOW)).toMatchObject({ error: 'WORKER_STOPPED' })
  expect(addTasks(stopped, 'w2', { seen: stopped.taskList, tasks: [{ title: 'Docs' }] }, NOW)).toMatchObject({ error: 'WORKER_STOPPED' })
  expect(shareEntry(stopped, 'w2', { kind: 'fact', text: 'The theme lives in theme.css' }, NOW)).toMatchObject({ error: 'WORKER_STOPPED' })
  expect(addNote(stopped, 'w2', 'A note', undefined, NOW)).toMatchObject({ error: 'WORKER_STOPPED' })
  expect(takeIntegration(stopped, 'w2', NOW)).toMatchObject({ error: 'WORKER_STOPPED' })
  expect(claimTask(stopped, 'w1', 1, 1, NOW)).not.toMatchObject({ error: 'WORKER_STOPPED' })
})

test('a worker that the person stopped, or a worker of a run that does not work, takes no new agent', () => {
  expect(restartWorker(stopWorker(working(), 'w1', NOW), 'w1', 'agent-9', NOW)).toMatchObject({ error: 'WORKER_STOPPED' })
  expect(restartWorker(stopRun(working(), NOW), 'w2', 'agent-9', NOW)).toMatchObject({ error: 'RUN_ENDED' })
})

test('a new agent of a worker gets the current entries again at its first reply', () => {
  const read = passContext(runOf(shareEntry(working(), 'w2', { kind: 'fact', text: 'The theme lives in theme.css' }, NOW)), 'w1').run
  const again = passContext(runOf(restartWorker(read, 'w1', 'agent-9', NOW)), 'w1')
  expect(again.context.map(entry => [entry.text, entry.seenBy])).toEqual([['The theme lives in theme.css', ['w1']]])
  expect(passContext(again.run, 'w1').context).toEqual([])
})

test('an entry that the first reply left out is not carried later, and does not count the reader', () => {
  const later = passContext(passContext(withFacts(21), 'w2').run, 'w2')
  expect(later.context).toEqual([])
  expect(later.run.context?.[0]?.seenBy).toEqual([])
})

test('a correction is new for a reader that got the entry it replaces', () => {
  const read = passContext(runOf(shareEntry(working(), 'w2', { kind: 'fact', text: 'The theme lives in theme.css' }, NOW)), 'w1').run
  const fixed = runOf(shareEntry(read, 'w2', { kind: 'fact', text: 'The theme lives in tokens.css', replaces: 1 }, NOW))
  expect(passContext(fixed, 'w1').context.map(entry => [entry.id, entry.replaces, entry.text])).toEqual([[2, 1, 'The theme lives in tokens.css']])
})

test('a worker of a run that meld 0.7.0 or older stored gets the current entries at its next reply, then only new ones', () => {
  const first = passContext(STORED_BY_0_6_0, 'w1')
  expect(first.context.map(entry => [entry.text, entry.seenBy])).toEqual([['The theme lives in theme.css', ['w1']]])
  const shared = runOf(shareEntry(first.run, 'w2', { kind: 'fail', text: 'A CSS filter inverts the images' }, NOW))
  expect(passContext(shared, 'w1').context.map(entry => entry.text)).toEqual(['A CSS filter inverts the images'])
})

test('a finished task shares its interfaces and what it left unfinished, with its commit', () => {
  const claimed = runOf(claimTask(withTask(), 'w1', 1, 1, NOW))
  const done = runOf(finishTask(claimed, 'w1', 1, 2, 'def5678', 'Tokens added', NOW, { interfaces: '--bg and --fg in theme.css', unfinished: 'The print styles' }))
  expect(currentContext(done).map(entry => [entry.kind, entry.by, entry.text, entry.commit])).toEqual([
    ['fact', 'w1', '#1 unfinished: The print styles', 'def5678'],
    ['interface', 'w1', '#1: --bg and --fg in theme.css', 'def5678'],
  ])
})

test('a finished task with no interfaces and nothing unfinished shares nothing', () => {
  const claimed = runOf(claimTask(withTask(), 'w1', 1, 1, NOW))
  expect(runOf(finishTask(claimed, 'w1', 1, 2, 'def5678', 'Tokens added', NOW, { interfaces: ' ', unfinished: '' })).context).toEqual([])
})

test('a finish with an interfaces text of more than 500 characters is refused', () => {
  const claimed = runOf(claimTask(withTask(), 'w1', 1, 1, NOW))
  expect(finishTask(claimed, 'w1', 1, 2, 'def5678', 'Tokens added', NOW, { interfaces: 'a'.repeat(501) })).toMatchObject({ error: 'INVALID' })
})

function storedByOldMeld(run: Run): Run {
  const { context: _context, ...stored } = run
  return stored as Run
}

test('a run that meld 0.5.3 stored, with no context, takes a share and shows it', () => {
  const shared = runOf(shareEntry(storedByOldMeld(working()), 'w1', { kind: 'fact', text: 'Colours live in theme.css' }, NOW))
  expect(currentContext(shared).map(entry => entry.text)).toEqual(['Colours live in theme.css'])
})

test('a board read of a run that meld 0.5.3 stored has an empty context', () => {
  expect(boardFor(storedByOldMeld(working()), 'w1').view.context).toEqual([])
})

test('a new task keeps its parent, size and needs', () => {
  expect(planned().tasks).toMatchObject([
    { id: 1, size: 'S' },
    { id: 2, size: 'L', needs: [1] },
    { id: 3, parent: 2 },
  ])
})

test('a new task has its add time, and a ready time when nothing holds it back', () => {
  const later = runOf(addTasks(planned(), 'w2', { seen: 1, tasks: [{ title: 'Print styles' }] }, NOW + 10))
  expect(later.tasks.map(task => [task.addedAt, task.readyAt])).toEqual([
    [NOW, NOW],
    [NOW, undefined],
    [NOW, undefined],
    [NOW + 10, NOW + 10],
  ])
})

test('an add that names a task that is not on the board is refused', () => {
  expect(addTasks(working(), 'w1', { seen: 0, tasks: [{ title: 'Toggle', needs: [4] }] }, NOW)).toMatchObject({ error: 'NOT_FOUND' })
  expect(addTasks(working(), 'w1', { seen: 0, tasks: [{ title: 'Toggle', parent: 4 }] }, NOW)).toMatchObject({ error: 'NOT_FOUND' })
})

test('a new task names an earlier task of the same add, and no later one', () => {
  expect(addTasks(working(), 'w1', { seen: 0, tasks: [{ title: 'Toggle', needs: [2] }, { title: 'Tokens' }] }, NOW)).toMatchObject({ error: 'NOT_FOUND' })
})

test('an add with a size other than S, M or L is refused', () => {
  const tasks = [{ title: 'Toggle', size: 'XL' }] as unknown as NewTask[]
  expect(addTasks(working(), 'w1', { seen: 0, tasks }, NOW)).toMatchObject({ error: 'INVALID' })
})

test('a task cannot need one of its ancestors', () => {
  const tasks: NewTask[] = [{ title: 'Toggle' }, { title: 'Toggle docs', parent: 1 }, { title: 'Toggle test', parent: 2, needs: [1] }]
  expect(addTasks(working(), 'w1', { seen: 0, tasks }, NOW)).toMatchObject({ error: 'INVALID' })
})

test('a task cannot go under a done task', () => {
  expect(addTasks(withTokensDone(NOW), 'w2', { seen: 1, tasks: [{ title: 'Token docs', parent: 1 }] }, NOW)).toMatchObject({ error: 'INVALID' })
})

test('a task cannot go under a task that a worker claims', () => {
  const claimed = runOf(claimTask(planned(), 'w1', 1, 1, NOW))
  expect(addTasks(claimed, 'w2', { seen: 1, tasks: [{ title: 'Token docs', parent: 1 }] }, NOW)).toMatchObject({ error: 'INVALID' })
})

test('a claim of a task whose need is not done is refused with WAITING, which names the need', () => {
  const run = runOf(addTasks(working(), 'w1', { seen: 0, tasks: [{ title: 'Theme tokens' }, { title: 'Dark toggle', needs: [1] }] }, NOW))
  const refused = claimTask(run, 'w2', 2, 1, NOW)
  expect(refused).toMatchObject({ error: 'WAITING' })
  expect(messageOf(refused)).toBe('#2 waits for #1, which is open. Claim a task that is ready.')
})

test('a part waits for the needs of its parent', () => {
  expect(claimTask(planned(), 'w2', 3, 1, NOW)).toMatchObject({ error: 'WAITING' })
})

test('a task is ready when its last need is done', () => {
  const done = withTokensDone(NOW + 5)
  expect(done.tasks.map(task => task.readyAt)).toEqual([NOW, NOW + 5, NOW + 5])
  expect(runOf(claimTask(done, 'w2', 3, 1, NOW + 6)).tasks[2]).toMatchObject({ state: 'claimed', owner: 'w2' })
})

test('a claim keeps its time, and a release counts the release and clears the time', () => {
  const claimed = runOf(claimTask(withTask(), 'w1', 1, 1, NOW + 1))
  expect(claimed.tasks[0]?.claimedAt).toBe(NOW + 1)
  const released = runOf(releaseTask(claimed, 'w1', 1, 2, 'Half done', NOW + 2))
  expect(released.tasks[0]?.claimedAt).toBeUndefined()
  expect(released.tasks[0]?.releases).toBe(1)
  const again = runOf(releaseTask(runOf(claimTask(released, 'w2', 1, 3, NOW + 3)), 'w2', 1, 4, '', NOW + 4))
  expect(again.tasks[0]?.releases).toBe(2)
})

test('a finished task keeps its done time', () => {
  expect(withTokensDone(NOW + 5).tasks[0]).toMatchObject({ state: 'done', claimedAt: NOW, doneAt: NOW + 5 })
})

test('a stopped worker gives back its claimed task as a release', () => {
  const stopped = stopWorker(runOf(claimTask(withTask(), 'w1', 1, 1, NOW)), 'w1', NOW + 1)
  expect(stopped.tasks[0]?.releases).toBe(1)
  expect(stopped.tasks[0]?.claimedAt).toBeUndefined()
})

test('a run that meld 0.6.0 stored takes claims, finishes and tasks that need its tasks', () => {
  const claimed = runOf(claimTask(STORED_BY_0_6_0, 'w2', 3, 1, NOW + 10))
  const done = runOf(finishTask(claimed, 'w1', 2, 2, 'aaa1111', 'Toggle added', NOW + 11))
  expect(done.tasks.map(task => [task.state, task.claimedAt, task.doneAt])).toEqual([
    ['done', undefined, undefined],
    ['done', undefined, NOW + 11],
    ['claimed', NOW + 10, undefined],
  ])
  const added = runOf(addTasks(done, 'w1', { seen: 1, tasks: [{ title: 'Release notes', needs: [3] }] }, NOW + 12))
  expect(claimTask(added, 'w1', 4, 1, NOW + 13)).toMatchObject({ error: 'WAITING' })
})

test('the tasks of a run that meld 0.6.0 stored get no ready time later', () => {
  const done = runOf(finishTask(STORED_BY_0_6_0, 'w1', 2, 2, 'aaa1111', 'Toggle added', NOW + 11))
  expect(done.tasks.map(task => task.readyAt)).toEqual([undefined, undefined, undefined])
})

test('a board read of a run that meld 0.7.0 stored carries its current entries one time, and counts its reader', () => {
  const read = boardFor(STORED_BY_0_7_0, 'w3')
  expect(read.view.context.map(entry => [entry.id, entry.seenBy])).toEqual([
    [3, ['w1', 'w3']],
    [2, ['w1', 'w2']],
  ])
  expect(read.view.tasks.map(task => [task.id, task.state])).toEqual([
    [1, 'open'],
    [2, 'done'],
    [3, 'open'],
    [4, 'claimed'],
    [5, 'claimed'],
  ])
  expect(boardFor(read.run, 'w3').view.context).toEqual([])
})

test('a split in a run that meld 0.7.0 stored needs the task list version of the run', () => {
  const parts: NewTask[] = [{ title: 'Light colours', size: 'S' }, { title: 'Dark colours', size: 'S' }]
  expect(splitTask(STORED_BY_0_7_0, 'w1', { task: 4, version: 1, seen: 1, tasks: parts }, NOW)).toMatchObject({ error: 'STALE_VERSION', taskList: 2 })
  const split = splitTask(STORED_BY_0_7_0, 'w1', { task: 4, version: 1, seen: 2, tasks: parts }, NOW)
  expect(split).toMatchObject({ value: { taskList: 3, tasks: [{ id: 6, parent: 4, state: 'claimed', owner: 'w1' }, { id: 7, parent: 4, state: 'open' }] } })
})

test('a run that meld 0.7.0 stored nudges at once its S task over 30 calls, and its task with no size at 60 calls', () => {
  expect(takeSplitNudge(STORED_BY_0_7_0, 'w1').task).toMatchObject({ id: 4, calls: 35, nudged: true })
  let run = STORED_BY_0_7_0
  for (let call = 38; call < 59; call++) run = countCall(run, 'w2')
  expect(takeSplitNudge(run, 'w2').task).toBeUndefined()
  expect(takeSplitNudge(countCall(run, 'w2'), 'w2').task).toMatchObject({ id: 5, calls: 60, nudged: true })
})

test('a board read of a run that meld 0.6.0 stored shows its tasks and context', () => {
  const view = boardFor(STORED_BY_0_6_0, 'w2').view
  expect(view.tasks.map(task => task.state)).toEqual(['done', 'claimed', 'open'])
  expect(view.context.map(entry => entry.text)).toEqual(['The theme lives in theme.css'])
})

test('a split makes the task a parent, gives the worker the first part, and leaves the other parts open', () => {
  const run = splitRun()
  expect(run.tasks).toMatchObject([
    { id: 1, state: 'open', version: 3 },
    { id: 2, parent: 1, size: 'S', state: 'claimed', owner: 'w1', version: 1, addedAt: NOW + 1, readyAt: NOW + 1, claimedAt: NOW + 1 },
    { id: 3, parent: 1, state: 'open', version: 1, readyAt: NOW + 1 },
    { id: 4, parent: 1, state: 'open', version: 1, needs: [3] },
  ])
  expect(run.tasks[0]?.owner).toBeUndefined()
  expect(run.tasks[0]?.claimedAt).toBeUndefined()
  expect(run.tasks[3]?.readyAt).toBeUndefined()
})

test('a split adds its parts to the task list in one change, and gives the parts to the worker', () => {
  const change = splitTask(runOf(claimTask(withTask(), 'w1', 1, 1, NOW)), 'w1', { task: 1, version: 2, seen: 1, tasks: PARTS }, NOW + 1)
  expect(change).toMatchObject({ value: { taskList: 2, tasks: [{ id: 2, state: 'claimed' }, { id: 3, state: 'open' }, { id: 4, state: 'open' }] } })
  expect(runOf(change).log.at(-1)?.text).toBe('split #1 into #2 Colour tokens; #3 Spacing tokens; #4 Token docs, and claimed #2')
})

test('a split from a worker that has not seen the newest tasks fails with STALE_VERSION and shows them, so no part needs the wrong task', () => {
  const claimed = runOf(claimTask(withTask(), 'w1', 1, 1, NOW))
  const added = runOf(addTasks(claimed, 'w2', { seen: 1, tasks: [{ title: 'Contrast check' }] }, NOW))
  const change = splitTask(added, 'w1', { task: 1, version: 2, seen: 1, tasks: PARTS }, NOW + 1)
  expect(change).toMatchObject({ error: 'STALE_VERSION', taskList: 2 })
  expect(isFailure(change) ? change.tasks?.map(task => [task.id, task.title]) : []).toEqual([
    [1, 'Theme tokens'],
    [2, 'Contrast check'],
  ])
  expect(messageOf(change)).toContain('split #1 again with seen 2')
})

test('a split with the task list version that a stale split returned goes through', () => {
  const added = runOf(addTasks(runOf(claimTask(withTask(), 'w1', 1, 1, NOW)), 'w2', { seen: 1, tasks: [{ title: 'Contrast check' }] }, NOW))
  const stale = splitTask(added, 'w1', { task: 1, version: 2, seen: 1, tasks: PARTS }, NOW + 1)
  const seen = isFailure(stale) ? (stale.taskList ?? 0) : 0
  const parts: NewTask[] = [{ title: 'Colour tokens' }, { title: 'Spacing tokens' }, { title: 'Token docs', needs: [4] }]
  const change = splitTask(added, 'w1', { task: 1, version: 2, seen, tasks: parts }, NOW + 1)
  expect(change).toMatchObject({ value: { taskList: 3, tasks: [{ id: 3 }, { id: 4 }, { id: 5, needs: [4] }] } })
})

test('a split from a worker that is not the owner is refused before its task list version', () => {
  const added = runOf(addTasks(runOf(claimTask(withTask(), 'w1', 1, 1, NOW)), 'w2', { seen: 1, tasks: [{ title: 'Contrast check' }] }, NOW))
  expect(splitTask(added, 'w2', { task: 1, version: 2, seen: 1, tasks: PARTS }, NOW)).toMatchObject({ error: 'NOT_OWNER' })
})

test('only the owner of a task splits it', () => {
  expect(splitTask(runOf(claimTask(withTask(), 'w1', 1, 1, NOW)), 'w2', { task: 1, version: 2, seen: 1, tasks: PARTS }, NOW)).toMatchObject({ error: 'NOT_OWNER' })
})

test('a split into fewer than two parts is refused', () => {
  expect(splitTask(runOf(claimTask(withTask(), 'w1', 1, 1, NOW)), 'w1', { task: 1, version: 2, seen: 1, tasks: [{ title: 'Colour tokens' }] }, NOW)).toMatchObject({ error: 'INVALID' })
})

test('a split whose first part waits is refused with WAITING', () => {
  const two = runOf(addTasks(working(), 'w1', { seen: 0, tasks: [{ title: 'Theme tokens' }, { title: 'Print styles' }] }, NOW))
  const parts: NewTask[] = [{ title: 'Colour tokens', needs: [2] }, { title: 'Spacing tokens' }]
  expect(splitTask(runOf(claimTask(two, 'w1', 1, 1, NOW)), 'w1', { task: 1, version: 2, seen: 1, tasks: parts }, NOW)).toMatchObject({ error: 'WAITING' })
})

test('a part cannot need the task that it splits', () => {
  const claimed = runOf(claimTask(withTask(), 'w1', 1, 1, NOW))
  expect(splitTask(claimed, 'w1', { task: 1, version: 2, seen: 1, tasks: [{ title: 'Colour tokens' }, { title: 'Spacing tokens', needs: [1] }] }, NOW)).toMatchObject({ error: 'INVALID' })
})

test('a new task cannot need a task that waits for its parent', () => {
  const claimed = runOf(claimTask(planned(), 'w1', 1, 1, NOW))
  const change = splitTask(claimed, 'w1', { task: 1, version: 2, seen: 1, tasks: [{ title: 'Colour tokens' }, { title: 'Toggle colours', needs: [2] }] }, NOW)
  expect(change).toMatchObject({ error: 'INVALID' })
  expect(messageOf(change)).toContain('#2')
})

test('a claim of a parent is refused, and names its open parts', () => {
  const change = claimTask(splitRun(), 'w2', 1, 3, NOW)
  expect(change).toMatchObject({ error: 'INVALID' })
  expect(messageOf(change)).toContain('#3')
})

test('a finish of a parent is refused, and names its open parts', () => {
  const change = finishTask(splitRun(), 'w1', 1, 3, 'aaa1111', 'Tokens added', NOW)
  expect(change).toMatchObject({ error: 'INVALID' })
  expect(messageOf(change)).toContain('#2 (claimed by w1), #3 (open), #4 (open)')
})

test('a parent is done when its last part is done, with no commit of its own', () => {
  const run = withPartsDone()
  expect(run.tasks[0]).toMatchObject({ state: 'done', version: 4, doneAt: NOW + 6 })
  expect(run.tasks[0]?.commit).toBeUndefined()
  expect(run.tasks[0]?.owner).toBeUndefined()
})

test('a parent with an open part is not done', () => {
  const second = runOf(finishTask(splitRun(), 'w1', 2, 1, 'aaa1111', 'Colours added', NOW + 2))
  expect(second.tasks[0]?.state).toBe('open')
})

test('a done parent makes its own parent done', () => {
  const nested = runOf(splitTask(splitRun(), 'w1', { task: 2, version: 1, seen: 2, tasks: [{ title: 'Light colours' }, { title: 'Dark colours' }] }, NOW + 2))
  const light = runOf(finishTask(nested, 'w1', 5, 1, 'ddd4444', 'Light added', NOW + 3))
  const dark = runOf(finishTask(runOf(claimTask(light, 'w2', 6, 1, NOW + 3)), 'w2', 6, 2, 'eee5555', 'Dark added', NOW + 4))
  const spacing = runOf(finishTask(runOf(claimTask(dark, 'w2', 3, 1, NOW + 5)), 'w2', 3, 2, 'bbb2222', 'Spacing added', NOW + 6))
  const docs = runOf(finishTask(runOf(claimTask(spacing, 'w1', 4, 1, NOW + 7)), 'w1', 4, 2, 'ccc3333', 'Docs added', NOW + 8))
  expect(docs.tasks.map(task => [task.id, task.state, task.doneAt])).toEqual([
    [1, 'done', NOW + 8],
    [2, 'done', NOW + 4],
    [3, 'done', NOW + 6],
    [4, 'done', NOW + 8],
    [5, 'done', NOW + 3],
    [6, 'done', NOW + 4],
  ])
})

test('a task that needs a parent is ready when the parent is done', () => {
  const added = runOf(addTasks(splitRun(), 'w2', { seen: 2, tasks: [{ title: 'Theme switch', needs: [1] }] }, NOW + 1))
  expect(added.tasks[4]?.readyAt).toBeUndefined()
  expect(withPartsDone(added).tasks[4]).toMatchObject({ id: 5, readyAt: NOW + 6 })
})
