import { expect, test } from 'claude-code/testing'

import { startRun as startBoard } from '../core/board'
import { cleanFolders } from '../core/clean'
import type { RunRecord } from '../core/ports'
import { JJ_LANE_TEMPLATE, jjConfigMark } from '../core/vcs'
import type { Run, RunState, VcsKind, WorkerId } from '../types'
import { FakeIo, HEAD } from './fake-io'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000
const DAY = 24 * HOUR
const ROOT = '/tmp/meld'
const CONFIG = '/root/.config/jj/repos/42ee0e08c27ca3c2d862/config.toml'
const MERGE = 'f'.repeat(40)
const OTHER = 'e'.repeat(40)

/** The run that this session stores: two workers in /tmp/meld/r1. */
function storedRun(): Run {
  const ids: WorkerId[] = ['w1', 'w2']
  const workers = ids.map(wid => ({ id: wid, agent: { type: 'meld:worker' }, path: `${ROOT}/r1/${wid}`, ref: `meld/r1/${wid}` }))
  return { ...startBoard({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW - 4 * DAY, workers }), state: 'working' }
}

/** What the board file of meld mcp keeps of the run of the folder `id`: two workers, and a last change 3 days ago. */
function recordOf(id: string, state: RunState, vcs: VcsKind = 'git', repo = '/repo'): RunRecord {
  return { id, board: `board-${id}`, state, vcs, repo, base: HEAD, workers: ['w1', 'w2'], changedAt: NOW - 3 * DAY }
}

type Setup = { record?: RunRecord; kb?: number }

/** A folder under /tmp/meld with one workspace, the record of its run when given, and the size that du gives. */
function folder(io: FakeIo, id: string, setup: Setup = {}): void {
  io.listings[ROOT] = [...(io.listings[ROOT] ?? []), { name: id, kind: 'dir', mtimeMs: 0 }]
  io.listings[`${ROOT}/${id}`] = [{ name: 'w1', kind: 'dir', mtimeMs: 0 }]
  if (setup.record) io.records.push(setup.record)
  io.answers[`du -sk ${ROOT}/${id}`] = `${setup.kb ?? 4}\t${ROOT}/${id}`
}

/** This session stores the run r1, which works in /tmp/meld/r1. */
function session(): FakeIo {
  const io = new FakeIo()
  io.current = storedRun()
  folder(io, 'r1', { record: { ...recordOf('r1', 'working'), changedAt: NOW } })
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

test('with no argument, /meld-clean lists each folder but the stored run: its id, the state of its record, when that changed, and its size', async () => {
  const io = session()
  folder(io, 'lq3x9a1', { record: recordOf('lq3x9a1', 'stopped'), kb: 7_025_459 })
  folder(io, 'lq4b2c3', { kb: 120 * 1024 })
  const text = await cleanFolders(io, '')
  expect(lineOf(text, 'lq3x9a1')).toBe('lq3x9a1: stopped, changed 3 d ago, 6.7 GB, git in /repo, no work')
  expect(lineOf(text, 'lq4b2c3')).toBe('lq4b2c3: no record, 120 MB')
  expect(lineOf(text, 'r1')).toBe('')
  expect(io.ran('rm ')).toBe(false)
})

test('the list line of a folder that is not maybe live ends with what its workspaces hold: no work, its commits and uncommitted edits, or that meld cannot read them', async () => {
  const io = session()
  folder(io, 'aaa', { record: recordOf('aaa', 'stopped') })
  folder(io, 'bbb', { record: { ...recordOf('bbb', 'ready'), changedAt: NOW - 2 * DAY } })
  io.answers[gitLog('bbb', 'w1')] = `${MERGE}\t${OTHER} ${HEAD}\tMerge w2\n${OTHER}\t${HEAD}\tAdd add()`
  io.answers[gitLog('bbb', 'w2')] = `${OTHER}\t${HEAD}\tAdd add()`
  folder(io, 'ccc', { record: recordOf('ccc', 'stopped', 'jj') })
  io.answers[jjFreshLog('ccc', 'w2')] = `${MERGE}\t1\t--\tw2@\t\n${OTHER}\t1\t--\t\tAdd add()\n`
  folder(io, 'ddd', { record: recordOf('ddd', 'stopped', 'jj') })
  io.answers[jjFreshLog('ddd', 'w1')] = `${MERGE}\t1\t--\tw1@\t\n`
  io.answers[jjFreshLog('ddd', 'w2')] = `${OTHER}\t1\t--\tw2@\t\n`
  folder(io, 'eee', { record: recordOf('eee', 'stopped') })
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
  folder(io, 'aaa', { record: recordOf('aaa', 'stopped') })
  const text = await cleanFolders(io, '')
  expect(text.split('\n').at(-1)).toBe(
    '/meld-clean <id> removes a folder with its workspaces and any work in them. /meld-clean --all removes only the folders that hold no work: it keeps those maybe live, as a run of another session can use them, those that hold work or whose workspaces meld cannot read, and those with no record that meld can read.',
  )
})

test('the list reads no workspace of a maybe live folder, as a run of another session can work in it', async () => {
  const io = session()
  folder(io, 'aaa', { record: { ...recordOf('aaa', 'working', 'jj'), changedAt: NOW - HOUR } })
  const text = await cleanFolders(io, '')
  expect(lineOf(text, 'aaa')).toBe('aaa: working, changed 1 h ago, 4 KB, jj in /repo, maybe live')
  expect(io.ran('jj ')).toBe(false)
})

test('the work check takes the workspaces from the id of the folder and the worker ids, and the base from the record', async () => {
  const io = session()
  folder(io, 'aaa', { record: { ...recordOf('aaa', 'stopped'), base: OTHER } })
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

test('a record that lacks a value, or names a base that is not a commit id, is not readable, so no value of it reaches git: --all keeps its folder', async () => {
  const io = session()
  folder(io, 'aaa', { record: { ...recordOf('aaa', 'stopped'), vcs: null } })
  folder(io, 'bbb', { record: { ...recordOf('bbb', 'stopped'), base: '--output=/tmp/x' } })
  const text = await cleanFolders(io, '')
  expect(lineOf(text, 'aaa')).toBe('aaa: record not readable, changed 3 d ago, 4 KB')
  expect(lineOf(text, 'bbb')).toBe('bbb: record not readable, changed 3 d ago, 4 KB')
  expect(await cleanFolders(io, '--all')).toBe('Kept aaa (record not readable) and bbb (record not readable). /meld-clean <id> removes one, with any work in it.')
  expect(io.ran('git ')).toBe(false)
  expect(folderNames(io)).toEqual(['r1', 'aaa', 'bbb'])
})

test('a record with no workers, or with a worker that meld does not name, is not readable, as the work check would miss workspaces of its folder: --all keeps it', async () => {
  const io = session()
  folder(io, 'aaa', { record: { ...recordOf('aaa', 'stopped'), workers: [] } })
  folder(io, 'bbb', { record: { ...recordOf('bbb', 'stopped'), workers: ['w1', 'w2', 'x3'] } })
  const text = await cleanFolders(io, '')
  expect(lineOf(text, 'aaa')).toBe('aaa: record not readable, changed 3 d ago, 4 KB')
  expect(lineOf(text, 'bbb')).toBe('bbb: record not readable, changed 3 d ago, 4 KB')
  expect(await cleanFolders(io, '--all')).toBe('Kept aaa (record not readable) and bbb (record not readable). /meld-clean <id> removes one, with any work in it.')
  expect(io.ran('git ')).toBe(false)
  expect(io.ran('rm ')).toBe(false)
})

test('the list marks a folder maybe live when its record says starting, working or ready and changed in the last 24 hours', async () => {
  const io = session()
  folder(io, 'aaa', { record: { ...recordOf('aaa', 'ready'), changedAt: NOW - 2 * HOUR } })
  folder(io, 'bbb', { record: recordOf('bbb', 'ready') })
  folder(io, 'ccc', { record: { ...recordOf('ccc', 'stopped'), changedAt: NOW - HOUR } })
  folder(io, 'ddd', { record: { ...recordOf('ddd', 'starting'), changedAt: NOW - 10 * 60_000 } })
  const text = await cleanFolders(io, '')
  expect(lineOf(text, 'aaa')).toBe('aaa: ready, changed 2 h ago, 4 KB, git in /repo, maybe live')
  expect(lineOf(text, 'bbb')).not.toContain('maybe live')
  expect(lineOf(text, 'ccc')).not.toContain('maybe live')
  expect(lineOf(text, 'ddd')).toContain('changed 10 min ago')
  expect(lineOf(text, 'ddd')).toContain('maybe live')
})

test('a new record that meld cannot read is not maybe live: --all keeps its folder as not readable', async () => {
  const io = session()
  folder(io, 'aaa', { record: { ...recordOf('aaa', 'working'), vcs: null, changedAt: NOW - HOUR } })
  expect(lineOf(await cleanFolders(io, ''), 'aaa')).toBe('aaa: record not readable, changed 1 h ago, 4 KB')
  expect(await cleanFolders(io, '--all')).toBe('Kept aaa (record not readable). /meld-clean aaa removes it, with any work in it.')
})

test('a folder with a board.json and no record of its run has no record: meld reads no board.json', async () => {
  const io = session()
  folder(io, 'aaa')
  io.listings[`${ROOT}/aaa`]?.push({ name: 'board.json', kind: 'file', mtimeMs: NOW - DAY })
  io.files[`${ROOT}/aaa/board.json`] = JSON.stringify({ ...storedRun(), id: 'aaa', state: 'stopped' })
  expect(lineOf(await cleanFolders(io, ''), 'aaa')).toBe('aaa: no record, 4 KB')
})

test('with nothing to clean, /meld-clean says so', async () => {
  expect(await cleanFolders(session(), '')).toBe('No folder under /tmp/meld is left from another run.')
  expect(await cleanFolders(new FakeIo(), '')).toBe('No folder under /tmp/meld is left from another run.')
})

test('an id removes its folder as Discard does: the folder, then the worktrees and branches in the repository of its record', async () => {
  const io = session()
  folder(io, 'aaa', { record: recordOf('aaa', 'stopped', 'git', '/elsewhere') })
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
  folder(io, 'aaa', { record: recordOf('aaa', 'stopped', 'jj') })
  io.answers[`jj -R ${ROOT}/aaa/jj config path --repo`] = CONFIG
  io.files[CONFIG] = `${jjConfigMark('aaa')}\n`
  await cleanFolders(io, 'aaa')
  expect(io.commands).toContain('rm -rf -- /root/.config/jj/repos/42ee0e08c27ca3c2d862')
  expect(folderNames(io)).toEqual(['r1'])
})

test('a folder with no record of its run loses only its folder, also when a record names another run', async () => {
  const io = session()
  folder(io, 'aaa')
  folder(io, 'bbb')
  io.records.push(recordOf('zzz', 'stopped', 'git', '/elsewhere'))
  expect(await cleanFolders(io, 'aaa bbb')).toBe('Removed aaa and bbb.')
  expect(io.commands.filter(command => !command.startsWith('du '))).toEqual(['rm -rf -- /tmp/meld/aaa', 'rm -rf -- /tmp/meld/bbb'])
  expect(io.cwds['rm -rf -- /tmp/meld/aaa']).toBe(ROOT)
})

test('a folder whose repository is gone still goes, with the repository config of jj', async () => {
  const io = session()
  folder(io, 'aaa', { record: recordOf('aaa', 'stopped', 'jj', '/gone') })
  io.goneDirs = ['/gone']
  io.answers[`jj -R ${ROOT}/aaa/jj config path --repo`] = CONFIG
  io.files[CONFIG] = `${jjConfigMark('aaa')}\n`
  expect(await cleanFolders(io, 'aaa')).toBe('Removed aaa.')
  expect(io.cwds['rm -rf -- /root/.config/jj/repos/42ee0e08c27ca3c2d862']).toBe(ROOT)
  expect(folderNames(io)).toEqual(['r1'])
})

test('/meld-clean never removes the run of this session, not even by its id', async () => {
  const io = session()
  folder(io, 'aaa', { record: recordOf('aaa', 'stopped') })
  expect(await cleanFolders(io, 'r1')).toBe('r1 is the run of this session: Discard it with /meld-discard or in the meld pane.')
  await cleanFolders(io, '--all')
  expect(io.ran('rm -rf -- /tmp/meld/r1')).toBe(false)
  expect(io.ran('git worktree remove --force /tmp/meld/r1')).toBe(false)
  expect(folderNames(io)).toEqual(['r1'])
})

test('--all skips the maybe live folders, and an id removes a maybe live folder too', async () => {
  const io = session()
  folder(io, 'aaa', { record: recordOf('aaa', 'stopped') })
  folder(io, 'bbb', { record: recordOf('bbb', 'ready') })
  folder(io, 'ddd', { record: { ...recordOf('ddd', 'working'), changedAt: NOW - HOUR } })
  const text = await cleanFolders(io, '--all')
  expect(folderNames(io)).toEqual(['r1', 'ddd'])
  expect(text).toBe('Removed aaa and bbb. Skipped ddd, maybe live: a run of another session can use it. /meld-clean ddd removes it.')
  expect(await cleanFolders(io, 'ddd')).toBe('Removed ddd.')
  expect(folderNames(io)).toEqual(['r1'])
})

test('--all removes only a folder with a readable record, not maybe live, and no work, and says why it keeps each other one', async () => {
  const io = session()
  folder(io, 'aaa', { record: recordOf('aaa', 'stopped') })
  folder(io, 'bbb', { record: recordOf('bbb', 'stopped') })
  io.answers[gitLog('bbb', 'w2')] = `${OTHER}\t${HEAD}\tAdd add()`
  folder(io, 'ccc', { record: recordOf('ccc', 'stopped') })
  io.failing = [gitLog('ccc', 'w1')]
  folder(io, 'ddd')
  folder(io, 'eee', { record: { ...recordOf('eee', 'stopped'), vcs: null } })
  folder(io, 'fff', { record: { ...recordOf('fff', 'working'), changedAt: NOW - HOUR } })
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
  folder(io, 'aaa', { record: recordOf('aaa', 'stopped', 'jj') })
  io.answers[jjFreshLog('aaa', 'w1')] = `${MERGE}\t1\t--\tw1@\t\n`
  const text = await cleanFolders(io, '--all')
  expect(io.commands.filter(command => command.includes(' log '))).toEqual([jjFreshLog('aaa', 'w1'), jjFreshLog('aaa', 'w2'), jjStrayLog('aaa')])
  expect(io.cwds[jjFreshLog('aaa', 'w1')]).toBe('/repo')
  expect(text).toBe('Kept aaa (holds work: uncommitted edits in w1). /meld-clean aaa removes it, with any work in it.')
  expect(io.ran('rm ')).toBe(false)
})

test('--all keeps a folder whose repository is gone, as meld cannot read its workspaces, and its id removes it', async () => {
  const io = session()
  folder(io, 'aaa', { record: recordOf('aaa', 'stopped', 'git', '/gone') })
  io.goneDirs = ['/gone']
  expect(await cleanFolders(io, '--all')).toBe('Kept aaa (workspaces not readable). /meld-clean aaa removes it, with any work in it.')
  expect(folderNames(io)).toEqual(['r1', 'aaa'])
  expect(await cleanFolders(io, 'aaa')).toBe('Removed aaa.')
  expect(folderNames(io)).toEqual(['r1'])
})

test('an id removes its folder even when its workspaces hold work, and reads none of them', async () => {
  const io = session()
  folder(io, 'aaa', { record: recordOf('aaa', 'stopped') })
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

test('without meld mcp, the command /meld-clean lists through the file system of the engine, finds no record, and removes only the folder', async ($, on) => {
  const ran: string[] = []
  on('clock.now', () => ({ value: NOW }))
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('fs.list', ($, e) => {
    if (e.path === ROOT) return { value: [{ name: 'abc', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('process.run', ($, e) => {
    ran.push(e.argv.join(' '))
    const stdout = e.argv[0] === 'du' ? `8\t${ROOT}/abc` : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const listed = await $.command.run(typed(''))
  expect(listed.text).toContain('abc: no record, 8 KB')
  await $.command.run(typed('abc'))
  expect(ran.filter(command => !command.startsWith('du '))).toEqual(['rm -rf -- /tmp/meld/abc'])
})
