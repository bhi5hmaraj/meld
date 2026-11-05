import { expect, test } from 'claude-code/testing'

import { startRun as startBoard } from '../core/board'
import { cleanFolders } from '../core/clean'
import { JJ_LANE_TEMPLATE, jjConfigMark } from '../core/vcs'
import type { RunRecord } from '../core/ports'
import type { Run, RunState, VcsKind, WorkerId } from '../types'
import { FakeIo, HEAD } from './fake-io'
import { STORED_BY_0_7_0 } from './stored-runs'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000
const DAY = 24 * HOUR
const ROOT = '/tmp/meld'
const CONFIG = '/root/.config/jj/repos/42ee0e08c27ca3c2d862/config.toml'
const MERGE = 'f'.repeat(40)
const OTHER = 'e'.repeat(40)

/** A run as meld mirrors it to board.json: two workers in the folder of the run. */
function boardRun(id: string, state: RunState, vcs: VcsKind = 'git', repo = '/repo'): Run {
  const ids: WorkerId[] = ['w1', 'w2']
  const workers = ids.map(wid => ({ id: wid, agent: { type: 'meld:worker' }, path: `${ROOT}/${id}/${wid}`, ref: vcs === 'jj' ? `${wid}@` : `meld/${id}/${wid}` }))
  return { ...startBoard({ id, request: 'Add a dark theme', repo, base: HEAD, vcs, now: NOW - 4 * DAY, workers }), state }
}

/** What the board file of meld mcp keeps of the run of the folder `id`: two workers on git in /repo. */
function recordOf(id: string, state: RunState, changedAt = NOW - 3 * DAY): RunRecord {
  return { id, board: `board-${id}`, state, vcs: 'git', repo: '/repo', base: HEAD, workers: ['w1', 'w2'], changedAt }
}

type Setup = { board?: Run | string; changedAt?: number; kb?: number }

/** A folder under /tmp/meld with one workspace, its board.json when given (a run, or a text as it is), and the size that du gives. */
function folder(io: FakeIo, id: string, setup: Setup = {}): void {
  io.listings[ROOT] = [...(io.listings[ROOT] ?? []), { name: id, kind: 'dir', mtimeMs: 0 }]
  io.listings[`${ROOT}/${id}`] = [{ name: 'w1', kind: 'dir', mtimeMs: 0 }]
  if (setup.board !== undefined) {
    io.listings[`${ROOT}/${id}`]?.push({ name: 'board.json', kind: 'file', mtimeMs: setup.changedAt ?? NOW - 3 * DAY })
    io.files[`${ROOT}/${id}/board.json`] = typeof setup.board === 'string' ? setup.board : `${JSON.stringify(setup.board, null, 2)}\n`
  }
  io.answers[`du -sk ${ROOT}/${id}`] = `${setup.kb ?? 4}\t${ROOT}/${id}`
}

/** This session stores the run r1, which works in /tmp/meld/r1. */
function session(): FakeIo {
  const io = new FakeIo()
  io.current = boardRun('r1', 'working')
  folder(io, 'r1', { board: io.current, changedAt: NOW })
  return io
}

function lineOf(text: string, id: string): string {
  return text.split('\n').find(line => line.startsWith(`${id}:`)) ?? ''
}

/** /meld-clean as the person types it at the terminal. */
function typed(args: string) {
  return { command: 'meld-clean', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }
}

function folderNames(io: FakeIo): string[] {
  return (io.listings[ROOT] ?? []).map(entry => entry.name)
}

/** The git log of the lane of a worker of the folder `id`, from `base`. */
function gitLog(id: string, worker: WorkerId, base = HEAD): string {
  return `git log --format=%H%x09%P%x09%s -n 40 ${base}..meld/${id}/${worker}`
}

/** The git log of the worktree of a worker from its HEAD and its branch, so a commit on a detached HEAD counts. */
function gitStrayLog(id: string, worker: WorkerId, base = HEAD): string {
  return `git log --format=%H%x09%P%x09%s -n 40 ^${base} meld/${id}/${worker} HEAD`
}

/** The jj log of the commits since the base that no working copy holds. */
function jjStrayLog(id: string): string {
  return `jj -R ${ROOT}/${id}/jj --ignore-working-copy log --no-graph --limit 40 -r meld_base.. ~ ::working_copies() -T ${JJ_LANE_TEMPLATE}`
}

/** The jj log of the lane of a worker, read in its folder, so jj first records the files there. */
function jjFreshLog(id: string, worker: WorkerId): string {
  return `jj -R ${ROOT}/${id}/${worker} log --no-graph --limit 40 -r meld_base..${worker}@ -T ${JJ_LANE_TEMPLATE}`
}

test('with no argument, /meld-clean lists each folder but the stored run: its id, the state of its board.json, when that changed, and its size', async () => {
  const io = session()
  folder(io, 'lq3x9a1', { board: boardRun('lq3x9a1', 'stopped'), changedAt: NOW - 3 * DAY, kb: 7_025_459 })
  folder(io, 'lq4b2c3', { kb: 120 * 1024 })
  const text = await cleanFolders(io, '')
  expect(lineOf(text, 'lq3x9a1')).toBe('lq3x9a1: stopped, changed 3 d ago, 6.7 GB, git in /repo, no work')
  expect(lineOf(text, 'lq4b2c3')).toBe('lq4b2c3: no record, 120 MB')
  expect(lineOf(text, 'r1')).toBe('')
  expect(io.ran('rm ')).toBe(false)
})

test('the list line of a folder that is not maybe live ends with what its workspaces hold: no work, its commits and uncommitted edits, or that meld cannot read them', async () => {
  const io = session()
  folder(io, 'aaa', { board: boardRun('aaa', 'stopped') })
  folder(io, 'bbb', { board: boardRun('bbb', 'ready'), changedAt: NOW - 2 * DAY })
  io.answers[gitLog('bbb', 'w1')] = `${MERGE}\t${OTHER} ${HEAD}\tMerge w2\n${OTHER}\t${HEAD}\tAdd add()`
  io.answers[gitLog('bbb', 'w2')] = `${OTHER}\t${HEAD}\tAdd add()`
  folder(io, 'ccc', { board: boardRun('ccc', 'stopped', 'jj') })
  io.answers[jjFreshLog('ccc', 'w2')] = `${MERGE}\t1\t--\tw2@\t\n${OTHER}\t1\t--\t\tAdd add()\n`
  folder(io, 'ddd', { board: boardRun('ddd', 'stopped', 'jj') })
  io.answers[jjFreshLog('ddd', 'w1')] = `${MERGE}\t1\t--\tw1@\t\n`
  io.answers[jjFreshLog('ddd', 'w2')] = `${OTHER}\t1\t--\tw2@\t\n`
  folder(io, 'eee', { board: boardRun('eee', 'stopped') })
  io.failing = [gitLog('eee', 'w2')]
  const text = await cleanFolders(io, '')
  expect(lineOf(text, 'aaa')).toBe('aaa: stopped, changed 3 d ago, 4 KB, git in /repo, no work')
  expect(lineOf(text, 'bbb')).toBe('bbb: ready, changed 2 d ago, 4 KB, git in /repo, holds work: 2 commits')
  expect(lineOf(text, 'ccc')).toBe('ccc: stopped, changed 3 d ago, 4 KB, jj in /repo, holds work: 1 commit and uncommitted edits in w2')
  expect(lineOf(text, 'ddd')).toBe('ddd: stopped, changed 3 d ago, 4 KB, jj in /repo, holds work: uncommitted edits in w1 and w2')
  expect(lineOf(text, 'eee')).toBe('eee: stopped, changed 3 d ago, 4 KB, git in /repo, workspaces not readable')
  expect(io.ran('rm ')).toBe(false)
})

test('the list says what --all keeps: the maybe live folders, those that hold work or whose workspaces meld cannot read, and those with no record it can read', async () => {
  const io = session()
  folder(io, 'aaa', { board: boardRun('aaa', 'stopped') })
  const text = await cleanFolders(io, '')
  expect(text.split('\n').at(-1)).toBe(
    '/meld-clean <id> removes a folder with its workspaces and any work in them. /meld-clean --all removes only the folders that hold no work: it keeps those maybe live, as a run of another session can use them, those that hold work or whose workspaces meld cannot read, and those with no record that meld can read.',
  )
})

test('the list reads no workspace of a maybe live folder, as a run of another session can work in it', async () => {
  const io = session()
  folder(io, 'aaa', { board: boardRun('aaa', 'working', 'jj'), changedAt: NOW - HOUR })
  const text = await cleanFolders(io, '')
  expect(lineOf(text, 'aaa')).toBe('aaa: working, changed 1 h ago, 4 KB, jj in /repo, maybe live')
  expect(io.ran('jj ')).toBe(false)
})

test('the work check takes the workspaces from the id of the folder and the base from its board.json, never the paths and refs in the file', async () => {
  const io = session()
  const board = { ...boardRun('aaa', 'stopped'), base: OTHER }
  const forged = { ...board, workers: board.workers.map(worker => ({ ...worker, path: '/repo', ref: 'main' })) }
  folder(io, 'aaa', { board: forged })
  io.answers[gitLog('aaa', 'w2', OTHER)] = `${MERGE}\t${OTHER}\tAdd add()`
  const text = await cleanFolders(io, '--all')
  expect(io.commands.filter(command => command.startsWith('git log'))).toEqual([
    gitLog('aaa', 'w1', OTHER),
    gitLog('aaa', 'w2', OTHER),
    gitStrayLog('aaa', 'w1', OTHER),
    gitStrayLog('aaa', 'w2', OTHER),
  ])
  expect(io.cwds[gitLog('aaa', 'w1', OTHER)]).toBe('/repo')
  expect(io.cwds[gitStrayLog('aaa', 'w1', OTHER)]).toBe('/tmp/meld/aaa/w1')
  expect(io.cwds['git status --porcelain --untracked-files=all']).toBe('/tmp/meld/aaa/w2')
  expect(text).toBe('Kept aaa (holds work: 1 commit). /meld-clean aaa removes it, with any work in it.')
  expect(folderNames(io)).toEqual(['r1', 'aaa'])
})

test('a board.json whose base is not a commit id is not readable, so no text of the file reaches git as an option', async () => {
  const io = session()
  folder(io, 'aaa', { board: { ...boardRun('aaa', 'stopped'), base: '--output=/tmp/x' } })
  const text = await cleanFolders(io, '')
  expect(lineOf(text, 'aaa')).toBe('aaa: record not readable, changed 3 d ago, 4 KB')
  expect(io.ran('git ')).toBe(false)
})

test('a board.json with no workers, or with a worker that meld does not name, is not readable, as the work check would miss workspaces of its folder: --all keeps it', async () => {
  const io = session()
  folder(io, 'aaa', { board: { ...boardRun('aaa', 'stopped'), workers: [] } })
  const run = boardRun('bbb', 'stopped')
  folder(io, 'bbb', { board: JSON.stringify({ ...run, workers: [...run.workers, { id: 'x3', path: '/repo', ref: 'main' }] }) })
  const text = await cleanFolders(io, '')
  expect(lineOf(text, 'aaa')).toBe('aaa: record not readable, changed 3 d ago, 4 KB')
  expect(lineOf(text, 'bbb')).toBe('bbb: record not readable, changed 3 d ago, 4 KB')
  expect(await cleanFolders(io, '--all')).toBe(
    'Kept aaa (record not readable) and bbb (record not readable). /meld-clean <id> removes one, with any work in it.',
  )
  expect(folderNames(io)).toEqual(['r1', 'aaa', 'bbb'])
  expect(io.ran('git ')).toBe(false)
  expect(io.ran('rm ')).toBe(false)
})

test('the list marks a folder maybe live when its board.json says starting, working or ready and changed in the last 24 hours', async () => {
  const io = session()
  folder(io, 'aaa', { board: boardRun('aaa', 'ready'), changedAt: NOW - 2 * HOUR })
  folder(io, 'bbb', { board: boardRun('bbb', 'ready'), changedAt: NOW - 3 * DAY })
  folder(io, 'ccc', { board: boardRun('ccc', 'stopped'), changedAt: NOW - HOUR })
  folder(io, 'ddd', { board: boardRun('ddd', 'starting'), changedAt: NOW - 10 * 60_000 })
  const text = await cleanFolders(io, '')
  expect(lineOf(text, 'aaa')).toBe('aaa: ready, changed 2 h ago, 4 KB, git in /repo, maybe live')
  expect(lineOf(text, 'bbb')).not.toContain('maybe live')
  expect(lineOf(text, 'ccc')).not.toContain('maybe live')
  expect(lineOf(text, 'ddd')).toContain('changed 10 min ago')
  expect(lineOf(text, 'ddd')).toContain('maybe live')
})

test('a board.json that meld cannot read is maybe live while it is new, as a live run can be writing it', async () => {
  const io = session()
  folder(io, 'aaa', { board: '{"id": "aaa", "state": "work', changedAt: NOW - HOUR })
  folder(io, 'bbb', { board: 'not json', changedAt: NOW - 2 * DAY })
  const text = await cleanFolders(io, '')
  expect(lineOf(text, 'aaa')).toBe('aaa: record not readable, changed 1 h ago, 4 KB, maybe live')
  expect(lineOf(text, 'bbb')).toBe('bbb: record not readable, changed 2 d ago, 4 KB')
})

test('a folder of a run that meld mcp keeps gets its state, its workspaces and its last change from the record of the run', async () => {
  const io = session()
  folder(io, 'aaa')
  io.records = [recordOf('aaa', 'stopped')]
  expect(lineOf(await cleanFolders(io, ''), 'aaa')).toBe('aaa: stopped, changed 3 d ago, 4 KB, git in /repo, no work')
  expect(io.commands).toContain(gitLog('aaa', 'w2'))
})

test('the record of a run comes before the board.json that an older meld wrote in its folder', async () => {
  const io = session()
  folder(io, 'aaa', { board: boardRun('aaa', 'working'), changedAt: NOW - HOUR })
  io.records = [recordOf('aaa', 'stopped', NOW - 2 * DAY)]
  expect(lineOf(await cleanFolders(io, ''), 'aaa')).toBe('aaa: stopped, changed 2 d ago, 4 KB, git in /repo, no work')
})

test('a record that says working and changed in the last 24 hours is maybe live, so meld reads none of its workspaces', async () => {
  const io = session()
  folder(io, 'aaa')
  io.records = [recordOf('aaa', 'working', NOW - HOUR)]
  expect(lineOf(await cleanFolders(io, ''), 'aaa')).toBe('aaa: working, changed 1 h ago, 4 KB, git in /repo, maybe live')
  expect(io.ran('git ')).toBe(false)
})

test('a record that lacks a value, or names a base that is not a commit id, is not readable: --all keeps its folder', async () => {
  const io = session()
  folder(io, 'aaa')
  folder(io, 'bbb')
  io.records = [{ ...recordOf('aaa', 'stopped'), vcs: null }, { ...recordOf('bbb', 'stopped'), base: '--output=/tmp/x' }]
  const text = await cleanFolders(io, '')
  expect(lineOf(text, 'aaa')).toBe('aaa: record not readable, changed 3 d ago, 4 KB')
  expect(lineOf(text, 'bbb')).toBe('bbb: record not readable, changed 3 d ago, 4 KB')
  expect(await cleanFolders(io, '--all')).toBe('Kept aaa (record not readable) and bbb (record not readable). /meld-clean <id> removes one, with any work in it.')
  expect(io.ran('git ')).toBe(false)
  expect(folderNames(io)).toEqual(['r1', 'aaa', 'bbb'])
})

test('--all removes the folder of a run that meld mcp keeps, with the worktrees and branches in the repository of its record', async () => {
  const io = session()
  folder(io, 'aaa')
  io.records = [{ ...recordOf('aaa', 'stopped'), repo: '/elsewhere' }]
  expect(await cleanFolders(io, '--all')).toBe('Removed aaa.')
  expect(io.cwds['git branch -D meld/aaa/w2']).toBe('/elsewhere')
  expect(folderNames(io)).toEqual(['r1'])
})

test('with nothing to clean, /meld-clean says so', async () => {
  expect(await cleanFolders(session(), '')).toBe('No folder under /tmp/meld is left from another run.')
  expect(await cleanFolders(new FakeIo(), '')).toBe('No folder under /tmp/meld is left from another run.')
})

test('an id removes its folder as Discard does: the folder, then the worktrees and branches in the repository of its board.json', async () => {
  const io = session()
  folder(io, 'aaa', { board: boardRun('aaa', 'stopped', 'git', '/elsewhere') })
  const text = await cleanFolders(io, 'aaa')
  expect(io.commands).toEqual(
    expect.arrayContaining(['rm -rf -- /tmp/meld/aaa', 'git worktree prune', 'git branch -D meld/aaa/w1', 'git branch -D meld/aaa/w2', 'git branch -D meld/aaa/integration']),
  )
  expect(io.cwds['git branch -D meld/aaa/w1']).toBe('/elsewhere')
  expect(folderNames(io)).toEqual(['r1'])
  expect(text).toBe('Removed aaa.')
})

test('a jj folder loses its folder and the repository config of jj', async () => {
  const io = session()
  folder(io, 'aaa', { board: boardRun('aaa', 'stopped', 'jj') })
  io.answers[`jj -R ${ROOT}/aaa/jj config path --repo`] = CONFIG
  io.files[CONFIG] = `${jjConfigMark('aaa')}\n`
  await cleanFolders(io, 'aaa')
  expect(io.commands).toContain('rm -rf -- /root/.config/jj/repos/42ee0e08c27ca3c2d862')
  expect(folderNames(io)).toEqual(['r1'])
})

test('the workspaces that a removal names come from the id of the folder, never from the paths and refs in board.json', async () => {
  const io = session()
  const board = boardRun('aaa', 'stopped')
  const forged = { ...board, workers: board.workers.map(worker => ({ ...worker, path: '/repo', ref: 'main' })) }
  folder(io, 'aaa', { board: forged })
  await cleanFolders(io, 'aaa')
  expect(io.commands).toContain('git branch -D meld/aaa/w1')
  expect(io.commands).not.toContain('git branch -D main')
  expect(io.commands).not.toContain('git worktree remove --force /repo')
})

test('a folder with no record, or a board.json of another run, loses only its folder', async () => {
  const io = session()
  folder(io, 'aaa')
  folder(io, 'bbb', { board: boardRun('zzz', 'stopped', 'git', '/elsewhere') })
  expect(await cleanFolders(io, 'aaa bbb')).toBe('Removed aaa and bbb.')
  expect(io.commands.filter(command => !command.startsWith('du '))).toEqual(['rm -rf -- /tmp/meld/aaa', 'rm -rf -- /tmp/meld/bbb'])
  expect(io.cwds['rm -rf -- /tmp/meld/aaa']).toBe(ROOT)
})

test('a folder whose repository is gone still goes, with the repository config of jj', async () => {
  const io = session()
  folder(io, 'aaa', { board: boardRun('aaa', 'stopped', 'jj', '/gone') })
  io.goneDirs = ['/gone']
  io.answers[`jj -R ${ROOT}/aaa/jj config path --repo`] = CONFIG
  io.files[CONFIG] = `${jjConfigMark('aaa')}\n`
  expect(await cleanFolders(io, 'aaa')).toBe('Removed aaa.')
  expect(io.cwds['rm -rf -- /root/.config/jj/repos/42ee0e08c27ca3c2d862']).toBe(ROOT)
  expect(folderNames(io)).toEqual(['r1'])
})

test('/meld-clean never removes the run of this session, not even by its id', async () => {
  const io = session()
  folder(io, 'aaa', { board: boardRun('aaa', 'stopped') })
  expect(await cleanFolders(io, 'r1')).toBe('r1 is the run of this session: Discard it with /meld-discard or in the meld pane.')
  await cleanFolders(io, '--all')
  expect(io.ran('rm -rf -- /tmp/meld/r1')).toBe(false)
  expect(io.ran('git worktree remove --force /tmp/meld/r1')).toBe(false)
  expect(folderNames(io)).toEqual(['r1'])
})

test('--all skips the maybe live folders, and an id removes a maybe live folder too', async () => {
  const io = session()
  folder(io, 'aaa', { board: boardRun('aaa', 'stopped') })
  folder(io, 'bbb', { board: boardRun('bbb', 'ready'), changedAt: NOW - 3 * DAY })
  folder(io, 'ddd', { board: boardRun('ddd', 'working'), changedAt: NOW - HOUR })
  const text = await cleanFolders(io, '--all')
  expect(folderNames(io)).toEqual(['r1', 'ddd'])
  expect(text).toBe('Removed aaa and bbb. Skipped ddd, maybe live: a run of another session can use it. /meld-clean ddd removes it.')
  expect(await cleanFolders(io, 'ddd')).toBe('Removed ddd.')
  expect(folderNames(io)).toEqual(['r1'])
})

test('--all removes only a folder with a readable board.json, not maybe live, and no work, and says why it keeps each other one', async () => {
  const io = session()
  folder(io, 'aaa', { board: boardRun('aaa', 'stopped') })
  folder(io, 'bbb', { board: boardRun('bbb', 'stopped') })
  io.answers[gitLog('bbb', 'w2')] = `${OTHER}\t${HEAD}\tAdd add()`
  folder(io, 'ccc', { board: boardRun('ccc', 'stopped') })
  io.failing = [gitLog('ccc', 'w1')]
  folder(io, 'ddd')
  folder(io, 'eee', { board: 'not json', changedAt: NOW - 2 * DAY })
  folder(io, 'fff', { board: boardRun('fff', 'working'), changedAt: NOW - HOUR })
  const text = await cleanFolders(io, '--all')
  expect(folderNames(io)).toEqual(['r1', 'bbb', 'ccc', 'ddd', 'eee', 'fff'])
  expect(text).toBe(
    'Removed aaa. Kept bbb (holds work: 1 commit), ccc (workspaces not readable), ddd (no record) and eee (record not readable). Skipped fff, maybe live: a run of another session can use it. /meld-clean <id> removes one, with any work in it.',
  )
  expect(io.commands.filter(command => command.startsWith('rm ') || command.startsWith('git worktree') || command.startsWith('git branch'))).toEqual([
    'rm -rf -- /tmp/meld/aaa',
    'git worktree prune',
    'git branch -D meld/aaa/w1',
    'git branch -D meld/aaa/w2',
    'git branch -D meld/aaa/integration',
  ])
})

test('--all reads each jj workspace in its folder, so edits that no jj command recorded keep the folder', async () => {
  const io = session()
  folder(io, 'aaa', { board: boardRun('aaa', 'stopped', 'jj') })
  io.answers[jjFreshLog('aaa', 'w1')] = `${MERGE}\t1\t--\tw1@\t\n`
  const text = await cleanFolders(io, '--all')
  expect(io.commands.filter(command => command.includes(' log '))).toEqual([jjFreshLog('aaa', 'w1'), jjFreshLog('aaa', 'w2'), jjStrayLog('aaa')])
  expect(io.cwds[jjFreshLog('aaa', 'w1')]).toBe('/repo')
  expect(text).toBe('Kept aaa (holds work: uncommitted edits in w1). /meld-clean aaa removes it, with any work in it.')
  expect(io.ran('rm ')).toBe(false)
})

test('--all keeps a folder whose repository is gone, as meld cannot read its workspaces, and its id removes it', async () => {
  const io = session()
  folder(io, 'aaa', { board: boardRun('aaa', 'stopped', 'git', '/gone') })
  io.goneDirs = ['/gone']
  expect(await cleanFolders(io, '--all')).toBe('Kept aaa (workspaces not readable). /meld-clean aaa removes it, with any work in it.')
  expect(folderNames(io)).toEqual(['r1', 'aaa'])
  expect(await cleanFolders(io, 'aaa')).toBe('Removed aaa.')
  expect(folderNames(io)).toEqual(['r1'])
})

test('an id removes its folder even when its workspaces hold work, and reads none of them', async () => {
  const io = session()
  folder(io, 'aaa', { board: boardRun('aaa', 'stopped') })
  io.answers[gitLog('aaa', 'w1')] = `${OTHER}\t${HEAD}\tAdd add()`
  expect(await cleanFolders(io, 'aaa')).toBe('Removed aaa.')
  expect(io.ran('git log')).toBe(false)
  expect(folderNames(io)).toEqual(['r1'])
})

test('an id that names no folder under /tmp/meld removes nothing', async () => {
  const io = session()
  folder(io, 'aaa')
  expect(await cleanFolders(io, '../home')).toBe('There is no folder ../home under /tmp/meld.')
  expect(await cleanFolders(io, 'zzz aaa')).toBe('Removed aaa. There is no folder zzz under /tmp/meld.')
  expect(io.commands.filter(command => command.startsWith('rm '))).toEqual(['rm -rf -- /tmp/meld/aaa'])
})

test('a folder that stays after its removal is named in the reply', async () => {
  const io = session()
  folder(io, 'aaa')
  io.failing = ['rm -rf -- /tmp/meld/aaa']
  expect(await cleanFolders(io, 'aaa')).toBe('aaa is still there: meld could not remove it.')
})

test('/meld-clean takes ids or --all, and no other flag', async () => {
  const io = session()
  folder(io, 'aaa')
  expect(await cleanFolders(io, '--force aaa')).toBe('/meld-clean takes run ids or --all, not --force.')
  expect(io.ran('rm ')).toBe(false)
})

test('a folder that meld 0.7.0 mirrored lists with its state, and goes with its jj workspaces; its jj config names no run, so it stays', async () => {
  const io = session()
  folder(io, STORED_BY_0_7_0.id, { board: STORED_BY_0_7_0, changedAt: NOW - 2 * DAY })
  io.answers[`jj -R ${ROOT}/${STORED_BY_0_7_0.id}/jj config path --repo`] = CONFIG
  io.files[CONFIG] = '[revset-aliases]\n"immutable_heads()" = "builtin_immutable_heads() | meld_base"\n'
  expect(lineOf(await cleanFolders(io, ''), STORED_BY_0_7_0.id)).toBe(`${STORED_BY_0_7_0.id}: working, changed 2 d ago, 4 KB, jj in /repo, no work`)
  expect(await cleanFolders(io, '--all')).toBe(`Removed ${STORED_BY_0_7_0.id}.`)
  expect(io.commands).toContain(`rm -rf -- ${ROOT}/${STORED_BY_0_7_0.id}`)
  expect(io.commands).not.toContain('rm -rf -- /root/.config/jj/repos/42ee0e08c27ca3c2d862')
})

test('the command /meld-clean lists through the file system of the engine and removes with rm', async ($, on) => {
  const ran: string[] = []
  const board = JSON.stringify(boardRun('abc', 'stopped'))
  on('clock.now', () => ({ value: NOW }))
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('fs.list', ($, e) => {
    if (e.path === ROOT) return { value: [{ name: 'abc', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }
    if (e.path === `${ROOT}/abc`) return { value: [{ name: 'board.json', kind: 'file', size: board.length, mtimeMs: NOW - 3 * DAY, isLink: false }] }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('fs.read', ($, e) => {
    if (e.path === `${ROOT}/abc/board.json`) return { value: board }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('process.run', ($, e) => {
    ran.push(e.argv.join(' '))
    const stdout = e.argv[0] === 'du' ? `8\t${ROOT}/abc` : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const listed = await $.command.run(typed(''))
  expect(listed.text).toContain('abc: stopped, changed 3 d ago, 8 KB, git in /repo')
  await $.command.run(typed('abc'))
  expect(ran).toContain('rm -rf -- /tmp/meld/abc')
  expect(ran).toContain('git branch -D meld/abc/w2')
})
