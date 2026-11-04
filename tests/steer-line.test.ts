import { expect, test } from 'claude-code/testing'
import type { ToolCallInput } from 'claude-code'

import { serveTool, steerRun } from '../core/actions'
import { addTasks, bindWorker, claimTask, declareFinal, finishTask, isFailure, lackingTasks, lineMerged, startRun, steer, takeIntegration } from '../core/board'
import { TOOL } from '../core/contract'
import { vcsFor } from '../core/vcs'
import type { Change, Run, VcsKind, WorkerId } from '../types'
import { FakeIo, HEAD } from './fake-io'
import { STORED_BY_0_7_0 } from './stored-runs'

const NOW = 1_800_000_000_000
const TOKENS = 'a'.repeat(40)
const TOGGLE = 'b'.repeat(40)
const LINE = 'c'.repeat(40)
const FINAL = 'f'.repeat(40)
const GIT_MOVE = `git update-ref refs/heads/meld/r1/integration ${FINAL}`
const JJ_MOVE = `git update-ref refs/heads/meld_integration ${FINAL}`
const JJ_IMPORT = 'jj -R /tmp/meld/r1/jj --ignore-working-copy git import'
const IDS: WorkerId[] = ['w1', 'w2', 'w3']
const LINE_HEAD_READ = 'git rev-parse --verify --quiet refs/heads/meld/r1/integration^{commit}'

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

function refOf(vcs: VcsKind, id: WorkerId): string {
  return vcs === 'jj' ? `${id}@` : `meld/r1/${id}`
}

/** Two tasks done by w1 and w2, both merged into the integration line at LINE. */
function lined(vcs: VcsKind): Run {
  const workers = IDS.map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: refOf(vcs, id), agent: { type: 'meld:worker' } }))
  let run = startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs, now: NOW, workers })
  for (const [index, id] of IDS.entries()) run = runOf(bindWorker(run, id, `agent-${index + 1}`, NOW))
  run = runOf(addTasks(run, 'w1', { seen: 0, tasks: [{ title: 'Theme tokens' }, { title: 'Dark toggle' }] }, NOW))
  run = runOf(finishTask(runOf(claimTask(run, 'w1', 1, 1, NOW)), 'w1', 1, 2, TOKENS, 'Tokens', NOW))
  run = runOf(finishTask(runOf(claimTask(run, 'w2', 2, 1, NOW)), 'w2', 2, 2, TOGGLE, 'Toggle', NOW))
  return lineMerged(lineMerged(run, 1, TOKENS, NOW), 2, LINE, NOW)
}

/** The run is ready: w2 integrated from the line, fixed what the merge broke, and declared FINAL. */
function ready(vcs: VcsKind): Run {
  return runOf(declareFinal(runOf(takeIntegration(lined(vcs), 'w2', NOW)), 'w2', FINAL, 'Dark theme', NOW))
}

function ioWith(run: Run): FakeIo {
  const io = new FakeIo()
  io.current = run
  return io
}

/**
 * w2 integrates, and declares FINAL just after the first read of the run: a steer reads a working run before it moves
 * the line, and saves to a ready one.
 */
class FinalAfterFirstRead extends FakeIo {
  declared = false

  override async read(): Promise<Run | null> {
    const seen = this.current
    if (!this.declared && seen?.state === 'working') {
      this.declared = true
      this.current = runOf(declareFinal(seen, 'w2', FINAL, 'Dark theme', NOW))
    }
    return seen
  }
}

/** Each read shows the ready run as it was before its final commit, so no try of a steer moves the line before its save. */
class BehindReady extends FakeIo {
  override async read(): Promise<Run | null> {
    return this.current && { ...this.current, state: 'working', final: undefined }
  }
}

test('git moves the line branch of the run to a commit, in the repository of the person', async () => {
  const io = new FakeIo()
  const moved = await vcsFor('git').setLine(io, ready('git'), FINAL)
  expect(moved.ok).toBe(true)
  expect(io.commands).toEqual([GIT_MOVE])
  expect(io.cwds[GIT_MOVE]).toBe('/repo')
})

test('jj moves the ref of the line in the store of the run, then imports it as the bookmark', async () => {
  const io = new FakeIo()
  const moved = await vcsFor('jj').setLine(io, ready('jj'), FINAL)
  expect(moved.ok).toBe(true)
  expect(io.commands).toEqual([JJ_MOVE, JJ_IMPORT])
  expect(io.cwds[JJ_MOVE]).toBe('/tmp/meld/r1/store.git')
})

test('jj imports nothing when the ref of the line does not move', async () => {
  const io = new FakeIo()
  io.failing = [JJ_MOVE]
  const moved = await vcsFor('jj').setLine(io, ready('jj'), FINAL)
  expect(moved.ok).toBe(false)
  expect(io.ran(JJ_IMPORT)).toBe(false)
})

test('a steer of a ready run whose line moved to the final commit gives the line that commit and the done tasks', () => {
  const steered = runOf(steer(ready('git'), 'Rename the toggle', NOW, FINAL))
  expect(steered.line).toEqual({ head: FINAL, tasks: [1, 2] })
  expect(steered.final).toBeUndefined()
  expect(steered.state).toBe('working')
})

test('a steer of a ready run is refused while the integration line is not at its final commit', () => {
  const refused = steer(ready('git'), 'Rename the toggle', NOW)
  expect(refused).toMatchObject({ error: 'LINE_NOT_MOVED' })
  expect(isFailure(refused) ? refused.message : '').toContain(`final commit ${FINAL.slice(0, 7)}`)
  expect(steer(ready('git'), 'Rename the toggle', NOW, LINE)).toMatchObject({ error: 'LINE_NOT_MOVED' })
})

test('when the integrator declares the final commit after the steer read a working run, meld moves the line to it and steers', async () => {
  const io = new FinalAfterFirstRead()
  io.current = runOf(takeIntegration(lined('git'), 'w2', NOW))
  const said = await steerRun(io, 'Rename the toggle')
  expect(said).toBe('All 3 workers get revision 2.')
  expect(io.cwds[GIT_MOVE]).toBe('/repo')
  expect(io.current?.line).toEqual({ head: FINAL, tasks: [1, 2] })
  expect(io.current?.state).toBe('working')
  expect(io.current?.final).toBeUndefined()
  expect(io.current?.revision).toBe(2)
})

test('a steer that never finds the line at the final commit of the ready run changes nothing and says to steer again', async () => {
  const io = new BehindReady()
  io.current = ready('git')
  const said = await steerRun(io, 'Rename the toggle')
  expect(said).toContain(`final commit ${FINAL.slice(0, 7)}`)
  expect(said).toContain('Steer again')
  expect(io.ran('git update-ref')).toBe(false)
  expect(io.current?.state).toBe('ready')
  expect(io.current?.final?.commit).toBe(FINAL)
  expect(io.current?.revision).toBe(1)
})

test('a steer from ready moves the git line to the final commit, so the next final starts from its work', async () => {
  const io = ioWith(ready('git'))
  await steerRun(io, 'Rename the toggle')
  expect(io.cwds[GIT_MOVE]).toBe('/repo')
  expect(io.current?.line).toEqual({ head: FINAL, tasks: [1, 2] })
  expect(io.current?.state).toBe('working')
  expect(io.current?.final).toBeUndefined()
  expect(io.current?.revision).toBe(2)
})

test('a steer from ready on jj moves the line ref in the store to the final commit, then imports it', async () => {
  const io = ioWith(ready('jj'))
  await steerRun(io, 'Rename the toggle')
  expect(io.cwds[JJ_MOVE]).toBe('/tmp/meld/r1/store.git')
  expect(io.commands.indexOf(JJ_IMPORT)).toBeGreaterThan(io.commands.indexOf(JJ_MOVE))
  expect(io.current?.line).toEqual({ head: FINAL, tasks: [1, 2] })
})

test('a run that meld 0.7.0 stored in ready gets its line at the final commit at a steer, so no old task merges again', async () => {
  const io = ioWith({ ...STORED_BY_0_7_0, state: 'ready', integrator: 'w1', final: { commit: FINAL, summary: 'Dark theme', by: 'w1' } })
  await steerRun(io, 'Rename the toggle')
  expect(io.commands).toContain(`git update-ref refs/heads/meld_integration ${FINAL}`)
  expect(io.current?.line).toEqual({ head: FINAL, tasks: [2] })
  expect(lackingTasks(io.current as Run)).toEqual([])
})

test('when the line cannot move to the final commit, the steer changes nothing and says why', async () => {
  const io = ioWith(ready('git'))
  io.failing = [GIT_MOVE]
  const said = await steerRun(io, 'Rename the toggle')
  expect(said).toContain(`could not move the integration line to the final commit ${FINAL.slice(0, 7)}`)
  expect(said).toContain('git: failed')
  expect(io.current?.state).toBe('ready')
  expect(io.current?.final?.commit).toBe(FINAL)
  expect(io.current?.revision).toBe(1)
  expect(io.current?.line).toEqual({ head: LINE, tasks: [1, 2] })
})

test('a steer of a working run leaves the integration line where it is', async () => {
  const io = ioWith(lined('git'))
  await steerRun(io, 'Rename the toggle')
  expect(io.ran('git update-ref')).toBe(false)
  expect(io.current?.line).toEqual({ head: LINE, tasks: [1, 2] })
})

test('a steer of a working run does not wait for the merges in the queue of the integration line', { timeoutMs: 3000 }, async () => {
  const workers = IDS.map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: refOf('git', id), agent: { type: 'meld:worker' } }))
  let run = startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers })
  for (const [index, id] of IDS.entries()) run = runOf(bindWorker(run, id, `agent-${index + 1}`, NOW))
  run = runOf(claimTask(runOf(addTasks(run, 'w1', { seen: 0, tasks: [{ title: 'Theme tokens' }] }, NOW)), 'w1', 1, 1, NOW))
  const io = ioWith(run)
  let release = () => {}
  io.gates[LINE_HEAD_READ] = new Promise<void>(resolve => (release = resolve))
  io.answers[`git rev-parse --verify --quiet ${TOKENS}^{commit}`] = TOKENS
  const finish = { tool: TOOL.finishTask, task: 1, version: 2, commit: TOKENS, summary: 'Tokens', agentId: 'agent-1' }
  const finishing = serveTool(io, finish as unknown as ToolCallInput)
  while (!io.commands.includes(LINE_HEAD_READ)) await io.sleep()
  const steered = await steerRun(io, 'Use blue for the toggle')
  release()
  await finishing
  expect(steered).toBe('All 3 workers get revision 2.')
  expect(io.current?.revision).toBe(2)
})
