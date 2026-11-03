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
  countNudge,
  currentContext,
  declareFinal,
  finishTask,
  isFailure,
  markBriefed,
  passContext,
  releaseTask,
  shareEntry,
  startRun,
  steer,
  stopRun,
  stopWorker,
  takeIntegration,
  takeNotice,
  workerOf,
} from '../hooks/board'
import type { Change, Run, WorkerId } from '../types'

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

test('a steer of a ready run asks for changes and the run works again', () => {
  const integrating = runOf(takeIntegration(working(), 'w2', NOW))
  const ready = runOf(declareFinal(integrating, 'w2', 'fff0000', 'All done', NOW))
  const changed = runOf(steer(ready, 'Rename the toggle', NOW))
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
  expect(twice.view.context[0]?.seenBy).toEqual(['w2'])
  expect(boardFor(twice.run, 'w3').run.context[0]?.seenBy).toEqual(['w2', 'w3'])
})

test('the context of any board reply counts its reader in seenBy', () => {
  const shared = runOf(shareEntry(working(), 'w1', { kind: 'fact', text: 'The theme lives in theme.css' }, NOW))
  const passed = passContext(shared, 'w2')
  expect(passed.context[0]?.seenBy).toEqual(['w2'])
  expect(passed.run.context[0]?.seenBy).toEqual(['w2'])
})

test('a read counts no reader for an entry that it does not show', () => {
  const read = passContext(withFacts(21), 'w2').run
  expect(read.context[0]?.seenBy).toEqual([])
  expect(read.context[1]?.seenBy).toEqual(['w2'])
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
