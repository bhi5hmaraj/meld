import { expect, test } from 'claude-code/testing'
import type { ToolCallInput } from 'claude-code'

import { controlRun, deliver, serveTool } from '../core/actions'
import { addIntegrateTask, addTasks, bindWorker, claimTask, declareFinal, finishTask, isFailure, lackingTasks, lineMerged, startRun as startBoard, takeIntegration } from '../core/board'
import { integrateStep, missingWorkText, TOOL } from '../core/contract'
import { JJ_RESOLVE_TEMPLATE, vcsFor } from '../core/vcs'
import type { ProcessResult } from '../core/ports'
import type { Change, Run, VcsKind, WorkerId } from '../types'
import { FakeIo, HEAD } from './fake-io'

const NOW = 1_800_000_000_000
const FULL = 'f'.repeat(40)
const TOKENS = 'b'.repeat(40)
const TOGGLE = 'c'.repeat(40)
const DOCS = 'd'.repeat(40)
const INTEGRATED = '1'.repeat(40)
const LINE = '2'.repeat(40)
const STORE = '/tmp/meld/r1/store.git'
const LACKS_TOGGLE = `git merge-base --is-ancestor ${TOGGLE} ${FULL}`
const REFUSED_DELIVERY =
  'Nothing changed: the final commit fffffff lacks the work of #2 Dark toggle, which is done on the board. Steer the run so that an agent merges it, for example /meld-steer Merge #2 into the final commit. Then deliver the new final commit.'
const PANE = {
  plugin: 'meld',
  component: 'Pane',
  requestId: 'meld',
  surface: 'desktop',
  props: { title: 'meld', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

/** Two workers and three tasks: Theme tokens, Dark toggle and Docs, all open. */
function planned(vcs: VcsKind = 'git'): Run {
  const ids: WorkerId[] = ['w1', 'w2']
  const workers = ids.map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: vcs === 'jj' ? `${id}@` : `meld/r1/${id}`, agent: { type: 'meld:worker' } }))
  let run = startBoard({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs, now: NOW, workers })
  for (const [index, id] of ids.entries()) run = runOf(bindWorker(run, id, `agent-${index + 1}`, NOW))
  return runOf(addTasks(run, 'w1', { seen: 0, tasks: [{ title: 'Theme tokens' }, { title: 'Dark toggle' }, { title: 'Docs' }] }, NOW))
}

/** The task claimed and finished by `by` with `commit`. */
function finished(run: Run, id: number, by: WorkerId, commit: string): Run {
  const claimed = runOf(claimTask(run, by, id, run.tasks.find(task => task.id === id)?.version ?? 0, NOW))
  return runOf(finishTask(claimed, by, id, claimed.tasks.find(task => task.id === id)?.version ?? 0, commit, `did #${id}`, NOW))
}

/** #1 and #2 are done, #3 is open, and w2 integrates. */
function integrating(vcs: VcsKind = 'git'): Run {
  return runOf(takeIntegration(finished(finished(planned(vcs), 1, 'w1', TOKENS), 2, 'w2', TOGGLE), 'w2', NOW))
}

/** The run of integrating(), ready with the final commit FULL. */
function ready(vcs: VcsKind = 'git'): Run {
  return runOf(declareFinal(integrating(vcs), 'w2', FULL, 'A dark theme', NOW))
}

function ioWith(run: Run): FakeIo {
  const io = new FakeIo()
  io.current = run
  io.answers['git rev-parse --verify --quiet HEAD^{commit}'] = FULL
  io.answers[`jj -R /tmp/meld/r1/w2 --ignore-working-copy log --no-graph -r @- -T ${JJ_RESOLVE_TEMPLATE}`] = `${FULL} clean`
  return io
}

function call(input: Record<string, unknown>): ToolCallInput {
  return input as unknown as ToolCallInput
}

function parsed(result: unknown): { error?: string; message?: string; ok?: boolean; text?: string } {
  if (typeof result !== 'string') throw new Error(`a tool result is a string, not ${typeof result}`)
  return JSON.parse(result)
}

const FINISH = { tool: TOOL.finish, commit: 'HEAD', summary: 'A dark theme', agentId: 'agent-2' }

/**
 * w1 finishes #3 while meld checks the final commit: the stored run gets the finish at the first merge-base, so the
 * save after the check sees a done task that the check did not read.
 */
class RacingIo extends FakeIo {
  raced = false

  override async run(argv: string[], cwd: string): Promise<ProcessResult> {
    const ran = await super.run(argv, cwd)
    if (!this.raced && argv[1] === 'merge-base' && this.current) {
      this.raced = true
      this.current = finished(this.current, 3, 'w1', DOCS)
    }
    return ran
  }
}

/** The run as the engine stores it for the plugin. */
function stored(run: Run, key: string) {
  return key === 'run' ? { value: { shape: 'run-5', value: run }, version: 1 } : { value: undefined, version: 0 }
}

/** git answers each command with no output, and fails the check that FULL holds TOGGLE. */
function gitAnswer(argv: readonly string[]) {
  const failed = argv.join(' ') === LACKS_TOGGLE
  return { value: { exitCode: failed ? 1 : 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}

test('git names the commits that a final commit lacks, with git merge-base --is-ancestor in the repository', async () => {
  const io = ioWith(integrating())
  io.failing = [LACKS_TOGGLE]
  expect(await vcsFor('git').missing(io, integrating(), FULL, [TOKENS, TOGGLE])).toEqual([TOGGLE])
  expect(io.cwds[`git merge-base --is-ancestor ${TOKENS} ${FULL}`]).toBe('/repo')
  expect(io.cwds[LACKS_TOGGLE]).toBe('/repo')
})

test('jj names the commits that a final commit lacks, with git merge-base --is-ancestor in the store of the run', async () => {
  const io = ioWith(integrating('jj'))
  io.failing = [LACKS_TOGGLE]
  expect(await vcsFor('jj').missing(io, integrating('jj'), FULL, [TOKENS, TOGGLE])).toEqual([TOGGLE])
  expect(io.cwds[`git merge-base --is-ancestor ${TOKENS} ${FULL}`]).toBe(STORE)
})

test('a commit that git cannot read counts as lacking', async () => {
  const io = ioWith(integrating())
  io.missing = ['git']
  expect(await vcsFor('git').missing(io, integrating(), FULL, [TOKENS])).toEqual([TOKENS])
})

test('finish refuses a final commit that lacks the commit of a done task with MISSING_WORK, and names the task and the steps', async () => {
  const io = ioWith(integrating())
  io.failing = [LACKS_TOGGLE]
  const replied = parsed((await serveTool(io, call(FINISH))).result)
  expect(replied.error).toBe('MISSING_WORK')
  expect(replied.message).toContain(`#2 Dark toggle (${TOGGLE.slice(0, 12)})`)
  expect(replied.message).not.toContain('#1 Theme tokens')
  expect(replied.message).toContain(`git merge ${TOGGLE}`)
  expect(io.current?.state).toBe('working')
  expect(io.current?.final).toBeUndefined()
})

test('on jj, finish reads the store of the run, and the steps of MISSING_WORK use jj new', async () => {
  const io = ioWith(integrating('jj'))
  io.failing = [LACKS_TOGGLE]
  const replied = parsed((await serveTool(io, call({ ...FINISH, commit: '@-' }))).result)
  expect(replied.error).toBe('MISSING_WORK')
  expect(replied.message).toContain(`jj new ${FULL} ${TOGGLE}`)
  expect(io.cwds[LACKS_TOGGLE]).toBe(STORE)
})

test('finish takes a final commit that holds the commit of every done task', async () => {
  const io = ioWith(integrating())
  const replied = parsed((await serveTool(io, call(FINISH))).result)
  expect(replied.ok).toBe(true)
  expect(io.current?.state).toBe('ready')
  expect(io.commands).toContain(`git merge-base --is-ancestor ${TOKENS} ${FULL}`)
  expect(io.commands).toContain(LACKS_TOGGLE)
})

test('a task done while meld checks the final commit counts as lacking, as the check did not read it', async () => {
  const io = new RacingIo()
  io.current = integrating()
  io.answers['git rev-parse --verify --quiet HEAD^{commit}'] = FULL
  const replied = parsed((await serveTool(io, call(FINISH))).result)
  expect(replied.error).toBe('MISSING_WORK')
  expect(replied.message).toContain(`#3 Docs (${DOCS.slice(0, 12)})`)
  expect(io.current?.state).toBe('working')
})

test('deliver refuses a final commit that lacks the commit of a done task, names the task and tells the person to steer the run', async () => {
  const io = ioWith(ready())
  io.failing = [LACKS_TOGGLE]
  expect(await deliver(io)).toBe(REFUSED_DELIVERY)
  expect(io.ran('git merge --no-ff')).toBe(false)
  expect(io.ran('git worktree remove')).toBe(false)
  expect(io.current?.state).toBe('ready')
})

test('deliver names each task that the final commit lacks', async () => {
  const io = ioWith(ready('jj'))
  io.failing = ['git merge-base --is-ancestor']
  const text = await deliver(io)
  expect(text).toContain('lacks the work of #1 Theme tokens and #2 Dark toggle, which are done on the board.')
  expect(text).toContain('/meld-steer Merge #1 and #2 into the final commit.')
  expect(io.ran('jj -R /tmp/meld/r1/jj --ignore-working-copy bookmark set meld_final')).toBe(false)
})

test('the deliver tool refuses a final commit that lacks the work of a done task', async () => {
  const io = ioWith(ready())
  io.failing = [LACKS_TOGGLE]
  expect(parsed((await serveTool(io, call({ tool: TOOL.deliver }))).result)).toEqual({ text: REFUSED_DELIVERY })
  expect(io.current?.state).toBe('ready')
})

test('/meld-deliver refuses a final commit that lacks the work of a done task', async () => {
  const io = ioWith(ready())
  io.failing = [LACKS_TOGGLE]
  expect(await controlRun(io, 'deliver')).toBe(REFUSED_DELIVERY)
  expect(io.ran('git merge --no-ff')).toBe(false)
})

test('the command /meld-deliver refuses it through the engine, and runs no merge', async ($, on) => {
  const ran: string[] = []
  const written: string[] = []
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: stored(ready(), e.key) }))
  on('state.set', ($, e) => {
    written.push(e.key)
    return { value: { isSet: true, version: 2 } }
  })
  on('process.run', ($, e) => {
    ran.push(e.argv.join(' '))
    return gitAnswer(e.argv)
  })
  const replied = await $.command.run({ command: 'meld-deliver', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } })
  expect(replied.text).toBe(REFUSED_DELIVERY)
  expect(ran).toContain(LACKS_TOGGLE)
  expect(ran.some(command => command.startsWith('git merge --no-ff'))).toBe(false)
  expect(written).toEqual([])
})

test('Deliver in the pane refuses it too, and its toast names the task and the steer', async ($, on) => {
  const toasts: string[] = []
  const ran: string[] = []
  const written: string[] = []
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: stored(ready(), e.key) }))
  on('state.set', ($, e) => {
    written.push(e.key)
    return { value: { isSet: true, version: 2 } }
  })
  on('process.run', ($, e) => {
    ran.push(e.argv.join(' '))
    return gitAnswer(e.argv)
  })
  on('ui.toast', ($, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'deliver' })
  expect(toasts).toEqual([`meld: ${REFUSED_DELIVERY}`])
  expect(ran.some(command => command.startsWith('git merge --no-ff'))).toBe(false)
  expect(written).toEqual([])
  await ui.unmount()
})


test('when a task and its task "integrate #N" both lack in the final commit, the steps merge only the commit of the integrate task, which holds the task', () => {
  const conflicted = runOf(addIntegrateTask(finished(planned(), 2, 'w2', TOGGLE), 2, 'The commit conflicts with the line.', NOW))
  const done = finished(conflicted, 4, 'w1', INTEGRATED)
  const text = missingWorkText(done, FULL, done.tasks.filter(task => task.id === 2 || task.id === 4))
  expect(text).toContain(`In your folder: git merge ${INTEGRATED}, fix the conflicts`)
  expect(text).not.toContain(`git merge ${TOGGLE}`)
})

test('on jj, the steps of a lacking task and its task "integrate #N" name only the commit of the integrate task', () => {
  const conflicted = runOf(addIntegrateTask(finished(planned('jj'), 2, 'w2', TOGGLE), 2, 'The commit conflicts with the line.', NOW))
  const done = finished(conflicted, 4, 'w1', INTEGRATED)
  const text = missingWorkText(done, FULL, done.tasks.filter(task => task.id === 2 || task.id === 4))
  expect(text).toContain(`In your folder: jj new ${FULL} ${INTEGRATED} -m "meld: integrate"`)
})

test('the integration step names only the commit of a task "integrate #N" when the line lacks both it and #N', () => {
  const lined = lineMerged(finished(planned(), 1, 'w1', TOKENS), 1, LINE, NOW)
  const conflicted = runOf(addIntegrateTask(finished(lined, 2, 'w2', TOGGLE), 2, 'The commit conflicts with the line.', NOW))
  const done = finished(conflicted, 4, 'w1', INTEGRATED)
  expect(integrateStep(done, lackingTasks(done))).toContain(`The line lacks #4 (${INTEGRATED.slice(0, 12)}): merge those commits too.`)
})
