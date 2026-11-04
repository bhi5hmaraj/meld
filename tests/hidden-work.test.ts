import { expect, test } from 'claude-code/testing'

import { startRun } from '../core/actions'
import { bindWorker, isFailure, startRun as startBoard, stopRun } from '../core/board'
import { cleanFolders } from '../core/clean'
import { JJ_LANE_TEMPLATE, vcsFor } from '../core/vcs'
import type { AgentSpec, Change, Run, VcsKind, WorkerId } from '../types'
import { FakeIo, HEAD } from './fake-io'

const NOW = 1_800_000_000_000
const DAY = 24 * 3_600_000
const FULL = 'f'.repeat(40)
const OTHER = 'e'.repeat(40)
const WORKER: AgentSpec = { type: 'meld:worker' }
const TWO = [WORKER, WORKER]
/** The status read that lists each new file, whatever status.showUntrackedFiles says; with that config at no, a plain git status --porcelain prints nothing for them. */
const NEW_FILES = 'git status --porcelain --untracked-files=all'
/** What jj 0.46 prints when a snapshot leaves out a new file over snapshot.max-new-file-size: jj log still exits 0, with the working copy empty. */
const REFUSED = [
  'Warning: Refused to snapshot some files:',
  '  big.bin: 1.0MiB (1100000 bytes); the maximum size allowed is 1.0MiB (1048576 bytes)',
  'Hint: This is to prevent large files from being added by accident. To fix this:',
  '  * Add the file(s) to `.gitignore`',
  '  * Run `jj config set --repo snapshot.max-new-file-size 1100000`',
  '    This will increase the maximum file size allowed for new files, in this repository only.',
].join('\n')
/** The error of a lane whose snapshot jj refused, in one line: the warning and the files that jj names under it. */
const REFUSAL = 'Refused to snapshot some files: big.bin: 1.0MiB (1100000 bytes); the maximum size allowed is 1.0MiB (1048576 bytes)'

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

/** A run of two workers in /tmp/meld/<id>, each bound to an agent, as a session stores it and as its board.json holds it. */
function working(id: string, vcs: VcsKind): Run {
  const ids: WorkerId[] = ['w1', 'w2']
  const workers = ids.map(wid => ({ id: wid, path: `/tmp/meld/${id}/${wid}`, ref: vcs === 'jj' ? `${wid}@` : `meld/${id}/${wid}`, agent: WORKER }))
  let run = startBoard({ id, request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs, now: NOW - 3 * DAY, workers })
  for (const [index, wid] of ids.entries()) run = runOf(bindWorker(run, wid, `agent-${index + 1}`, NOW - 3 * DAY))
  return run
}

/** The folder of a run under /tmp/meld that another session stopped 3 days ago, with its board.json. */
function leftFolder(io: FakeIo, run: Run): void {
  io.listings['/tmp/meld'] = [...(io.listings['/tmp/meld'] ?? []), { name: run.id, kind: 'dir', mtimeMs: 0 }]
  io.listings[`/tmp/meld/${run.id}`] = [{ name: 'board.json', kind: 'file', mtimeMs: NOW - 3 * DAY }]
  io.files[`/tmp/meld/${run.id}/board.json`] = `${JSON.stringify(run, null, 2)}\n`
}

/** The jj log of the lane of a worker, read in its folder, so jj first records the files there. */
function jjFreshLog(id: string, worker: WorkerId): string {
  return `jj -R /tmp/meld/${id}/${worker} log --no-graph --limit 40 -r meld_base..${worker}@ -T ${JJ_LANE_TEMPLATE}`
}

test('a git lane counts new files as edits, also when status.showUntrackedFiles=no hides them from git status', async () => {
  const io = new FakeIo()
  io.answers[NEW_FILES] = '?? notes.md'
  const lanes = await vcsFor('git').lanes(io, working('r1', 'git'), { snapshot: true })
  expect(lanes).toStrictEqual([
    { id: 'w1', commits: [], edits: true },
    { id: 'w2', commits: [], edits: true },
  ])
  expect(io.cwds[NEW_FILES]).toBe('/tmp/meld/r1/w2')
})

test('a jj lane is not readable when jj refused to snapshot a new file, though jj log exits 0 with an empty working copy', async () => {
  const io = new FakeIo()
  io.outcomes[jjFreshLog('r1', 'w1')] = { exitCode: 0, stdout: `${FULL}\t1\t-e\tw1@\t\n${OTHER}\t1\t--\t\tAdd add()\n`, stderr: REFUSED }
  const lanes = await vcsFor('jj').lanes(io, working('r1', 'jj'), { snapshot: true })
  expect(lanes).toStrictEqual([
    { id: 'w1', commits: [{ commit: OTHER, subject: 'Add add()', parents: 1, conflict: false }], edits: false, error: REFUSAL },
    { id: 'w2', commits: [], edits: false },
  ])
})

test('a start over a stopped git run whose only work is new files that git status hides refuses, and removes nothing', async () => {
  const io = new FakeIo()
  io.current = stopRun(working('r1', 'git'), NOW)
  io.answers[NEW_FILES] = '?? notes.md'
  const result = await startRun(io, '/repo', { request: 'More', agents: TWO, vcs: 'git' })
  expect(result.text).toBe(
    'Run r1 stopped with work in /tmp/meld/r1: 0 commits, and uncommitted edits in w1 and w2. /meld-discard or Discard in the meld pane removes its workspaces, then you can start again.',
  )
  expect(io.ran('git worktree remove')).toBe(false)
  expect(io.ran('rm ')).toBe(false)
  expect(io.current).toMatchObject({ id: 'r1', state: 'stopped' })
})

test('a start over a stopped jj run whose snapshot jj refused refuses, names the file, and removes nothing', async () => {
  const io = new FakeIo()
  io.current = stopRun(working('r1', 'jj'), NOW)
  io.outcomes[jjFreshLog('r1', 'w2')] = { exitCode: 0, stdout: `${FULL}\t1\t-e\tw2@\t\n`, stderr: REFUSED }
  const result = await startRun(io, '/repo', { request: 'More', agents: TWO, vcs: 'auto' })
  expect(result.text).toBe(
    `Run r1 stopped, and meld cannot read its workspaces in /tmp/meld/r1 (w2: ${REFUSAL}), so they can hold work. /meld-discard or Discard in the meld pane removes them, then you can start again.`,
  )
  expect(io.ran('rm ')).toBe(false)
  expect(io.current).toMatchObject({ id: 'r1', state: 'stopped' })
})

test('/meld-clean --all keeps a git folder whose only work is new files that git status hides', async () => {
  const io = new FakeIo()
  leftFolder(io, stopRun(working('aaa', 'git'), NOW - 3 * DAY))
  io.answers[NEW_FILES] = '?? notes.md'
  expect(await cleanFolders(io, '--all')).toBe('Kept aaa (holds work: uncommitted edits in w1 and w2). /meld-clean aaa removes it, with any work in it.')
  expect(io.ran('git worktree remove')).toBe(false)
  expect(io.ran('rm ')).toBe(false)
})

test('/meld-clean --all keeps a jj folder whose snapshot jj refused, and its list line says the workspaces are not readable', async () => {
  const io = new FakeIo()
  leftFolder(io, stopRun(working('bbb', 'jj'), NOW - 3 * DAY))
  io.outcomes[jjFreshLog('bbb', 'w1')] = { exitCode: 0, stdout: `${FULL}\t1\t-e\tw1@\t\n`, stderr: REFUSED }
  expect(await cleanFolders(io, '')).toContain('bbb: stopped, board.json changed 3 d ago, jj in /repo, workspaces not readable')
  expect(await cleanFolders(io, '--all')).toBe('Kept bbb (workspaces not readable). /meld-clean bbb removes it, with any work in it.')
  expect(io.ran('rm ')).toBe(false)
})

test('a start over a stopped git run whose only work is a commit on a detached HEAD of a worktree refuses, and removes nothing', async () => {
  const io = new FakeIo()
  io.current = stopRun(working('r1', 'git'), NOW)
  io.answers[`git log --format=%H%x09%P%x09%s -n 40 ^${HEAD} meld/r1/w1 HEAD`] = `${FULL}\t${HEAD}\tTokens on a detached HEAD`
  const result = await startRun(io, '/repo', { request: 'More', agents: TWO, vcs: 'git' })
  expect(result.text).toBe('Run r1 stopped with work in /tmp/meld/r1: 1 commit. /meld-discard or Discard in the meld pane removes its workspaces, then you can start again.')
  expect(io.ran('rm ')).toBe(false)
  expect(io.current).toMatchObject({ id: 'r1', state: 'stopped' })
})

test('a start over a stopped jj run whose only work is an edit that a later jj new left behind refuses, and removes nothing', async () => {
  const io = new FakeIo()
  io.current = stopRun(working('r1', 'jj'), NOW)
  io.answers[`jj -R /tmp/meld/r1/jj --ignore-working-copy log --no-graph --limit 40 -r meld_base.. ~ ::working_copies() -T ${JJ_LANE_TEMPLATE}`] = `${OTHER}\t1\t--\t\t\n${FULL}\t1\t-e\t\t\n`
  const result = await startRun(io, '/repo', { request: 'More', agents: TWO, vcs: 'auto' })
  expect(result.text).toBe('Run r1 stopped with work in /tmp/meld/r1: 1 commit. /meld-discard or Discard in the meld pane removes its workspaces, then you can start again.')
  expect(io.ran('rm ')).toBe(false)
  expect(io.current).toMatchObject({ id: 'r1', state: 'stopped' })
})
