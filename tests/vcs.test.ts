import { expect, test } from 'claude-code/testing'

import { bindWorker, isFailure, startRun } from '../hooks/board'
import { detectVcs, JJ_LANE_TEMPLATE, JJ_RESOLVE_TEMPLATE, vcsFor } from '../hooks/vcs'
import type { Change, Run, VcsKind, WorkerId } from '../types'
import { FakeIo, HEAD } from './fake-io'

const NOW = 1_800_000_000_000
const FULL = 'f'.repeat(40)
const OTHER = 'e'.repeat(40)
const JJ_REPO = '/tmp/meld/r1/jj'
const STORE = '/tmp/meld/r1/store.git'
const CONFIG = '/root/.config/jj/repos/42ee0e08c27ca3c2d862/config.toml'
const IDS: WorkerId[] = ['w1', 'w2']

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

function runOn(vcs: VcsKind): Run {
  const ref = (id: WorkerId) => (vcs === 'jj' ? `${id}@` : `meld/r1/${id}`)
  const workers = IDS.map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: ref(id), agent: { type: 'meld:worker' } }))
  const fresh = startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs, now: NOW, workers })
  return runOf(bindWorker(runOf(bindWorker(fresh, 'w1', 'agent-1', NOW)), 'w2', 'agent-2', NOW))
}

function jjLog(worker: WorkerId): string {
  return `jj -R ${JJ_REPO} --ignore-working-copy log --no-graph --limit 40 -r meld_base..${worker}@ -T ${JJ_LANE_TEMPLATE}`
}

test('meld chooses jj when jj 0.40 or newer answers', async () => {
  const io = new FakeIo()
  io.answers['jj --version'] = 'jj 0.46.0-7d382314f9420b4b8d932245b49c99492c812b9f'
  expect(await detectVcs(io, '/repo')).toBe('jj')
})

test('meld chooses git when jj is older than 0.40', async () => {
  const io = new FakeIo()
  io.answers['jj --version'] = 'jj 0.39.1'
  expect(await detectVcs(io, '/repo')).toBe('git')
})

test('meld chooses git when jj is not installed', async () => {
  const io = new FakeIo()
  io.missing = ['jj']
  expect(await detectVcs(io, '/repo')).toBe('git')
})

test('git makes one worktree and branch per worker from the base', async () => {
  const io = new FakeIo()
  const prepared = await vcsFor('git').prepare(io, { id: 'r1', repo: '/repo', base: HEAD }, ['w1', 'w2', 'w3'])
  expect(prepared).toEqual({
    workspaces: [
      { path: '/tmp/meld/r1/w1', ref: 'meld/r1/w1' },
      { path: '/tmp/meld/r1/w2', ref: 'meld/r1/w2' },
      { path: '/tmp/meld/r1/w3', ref: 'meld/r1/w3' },
    ],
  })
  expect(io.commands).toContain(`git worktree add -b meld/r1/w3 /tmp/meld/r1/w3 ${HEAD}`)
})

test('git removes the worktrees it made when a later one fails', async () => {
  const io = new FakeIo()
  io.failing = ['git worktree add -b meld/r1/w2']
  expect(await vcsFor('git').prepare(io, { id: 'r1', repo: '/repo', base: HEAD }, ['w1', 'w2'])).toEqual({ error: 'git: failed' })
  expect(io.commands).toContain('git worktree remove --force /tmp/meld/r1/w1')
  expect(io.commands).toContain('git branch -D meld/r1/w1')
})

test('git resolves a revision in the folder of the worker, so HEAD is its own', async () => {
  const io = new FakeIo()
  io.answers['git rev-parse --verify --quiet HEAD^{commit}'] = FULL
  const run = runOn('git')
  expect(await vcsFor('git').resolve(io, run, run.workers[1]!, 'HEAD')).toEqual({ commit: FULL, conflict: false })
  expect(io.cwds['git rev-parse --verify --quiet HEAD^{commit}']).toBe('/tmp/meld/r1/w2')
})

test('git does not resolve a revision that names no commit', async () => {
  const io = new FakeIo()
  io.failing = ['git rev-parse --verify']
  const run = runOn('git')
  expect(await vcsFor('git').resolve(io, run, run.workers[0]!, 'nothere')).toBeUndefined()
})

test('git lanes are the commits of each branch since the base, and its uncommitted edits', async () => {
  const io = new FakeIo()
  io.answers[`git log --format=%H%x09%P%x09%s -n 40 ${HEAD}..meld/r1/w1`] = `${FULL}\t${OTHER} ${HEAD}\tMerge w2\n${OTHER}\t${HEAD}\tAdd add()`
  io.dirty = true
  const lanes = await vcsFor('git').lanes(io, runOn('git'))
  expect(lanes[0]).toEqual({
    id: 'w1',
    commits: [
      { commit: FULL, subject: 'Merge w2', parents: 2, conflict: false },
      { commit: OTHER, subject: 'Add add()', parents: 1, conflict: false },
    ],
    edits: true,
  })
  expect(lanes[1]).toEqual({ id: 'w2', commits: [], edits: true })
})

test('the result counts every file and keeps the hunks of the first files', async () => {
  const io = new FakeIo()
  io.answers[`git diff --no-renames --numstat ${HEAD} ${FULL}`] = '12\t3\tsrc/math.js\n-\t-\tlogo.png\n4\t0\tREADME.md'
  io.answers[`git diff --no-renames ${HEAD} ${FULL} -- src/math.js`] =
    'diff --git a/src/math.js b/src/math.js\nindex 1..2 100644\n--- a/src/math.js\n+++ b/src/math.js\n@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d'
  const result = await vcsFor('git').result(io, runOn('git'), FULL)
  expect(result).toMatchObject({ commit: FULL, fileCount: 3, added: 16, removed: 3 })
  expect(result.files[0]).toEqual({ path: 'src/math.js', added: 12, removed: 3, patch: '--- a/src/math.js\n+++ b/src/math.js\n@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d' })
  expect(result.files[1]).toMatchObject({ path: 'logo.png', added: 0, removed: 0 })
})

test('git delivers with a merge commit and aborts a merge that fails', async () => {
  const io = new FakeIo()
  io.failing = ['git merge --no-ff']
  expect((await vcsFor('git').deliver(io, runOn('git'), FULL, 'meld: Add a dark theme')).ok).toBe(false)
  expect(io.commands).toContain('git merge --abort')
})

test('git removal drops the worktrees, the branches and the run folder', async () => {
  const io = new FakeIo()
  await vcsFor('git').remove(io, runOn('git'))
  expect(io.commands).toContain('git worktree remove --force /tmp/meld/r1/w2')
  expect(io.commands).toContain('git branch -D meld/r1/w2')
  expect(io.commands).toContain('rm -rf -- /tmp/meld/r1')
})

test('jj makes a private store over the objects of the repository, with one ref for the base', async () => {
  const io = new FakeIo()
  io.answers['git rev-parse --path-format=absolute --git-common-dir'] = '/repo/.git'
  io.answers[`jj -R ${JJ_REPO} config path --repo`] = CONFIG
  io.answers['git config user.name'] = 'Sample Person'
  io.answers['git config user.email'] = 'sample@example.com'
  const prepared = await vcsFor('jj').prepare(io, { id: 'r1', repo: '/repo', base: HEAD }, ['w1', 'w2'])
  expect(prepared).toEqual({
    workspaces: [
      { path: '/tmp/meld/r1/w1', ref: 'w1@' },
      { path: '/tmp/meld/r1/w2', ref: 'w2@' },
    ],
  })
  expect(io.files[`${STORE}/objects/info/alternates`]).toBe('/repo/.git/objects\n')
  expect(io.commands).toContain(`git update-ref refs/heads/meld_base ${HEAD}`)
  expect(io.cwds[`git update-ref refs/heads/meld_base ${HEAD}`]).toBe(STORE)
  expect(io.commands).toContain(`jj git init --git-repo ${STORE} ${JJ_REPO}`)
  expect(io.commands).toContain(`jj -R ${JJ_REPO} workspace add --name w2 -r meld_base /tmp/meld/r1/w2`)
})

test('jj gets a repository config: the identity of git, no editor, and a base that cannot change', async () => {
  const io = new FakeIo()
  io.answers[`jj -R ${JJ_REPO} config path --repo`] = CONFIG
  io.answers['git config user.name'] = 'Sample "Q" Person'
  io.answers['git config user.email'] = 'sample@example.com'
  await vcsFor('jj').prepare(io, { id: 'r1', repo: '/repo', base: HEAD }, ['w1'])
  const config = io.files[CONFIG] ?? ''
  expect(config).toContain('name = "Sample \\"Q\\" Person"')
  expect(config).toContain('email = "sample@example.com"')
  expect(config).toContain('editor = "false"')
  expect(config).toContain('"immutable_heads()" = "builtin_immutable_heads() | meld_base"')
})

test('jj removes what it made when a workspace fails', async () => {
  const io = new FakeIo()
  io.answers[`jj -R ${JJ_REPO} config path --repo`] = CONFIG
  io.failing = [`jj -R ${JJ_REPO} workspace add --name w2`]
  expect(await vcsFor('jj').prepare(io, { id: 'r1', repo: '/repo', base: HEAD }, ['w1', 'w2'])).toEqual({ error: 'jj: failed' })
  expect(io.commands).toContain('rm -rf -- /tmp/meld/r1')
  expect(io.commands).toContain('rm -rf -- /root/.config/jj/repos/42ee0e08c27ca3c2d862')
})

test('jj resolves one revision in the folder of the worker, with its conflict state', async () => {
  const io = new FakeIo()
  const command = `jj -R /tmp/meld/r1/w2 --ignore-working-copy log --no-graph -r @- -T ${JJ_RESOLVE_TEMPLATE}`
  io.answers[command] = `${FULL} conflict\n`
  const run = runOn('jj')
  expect(await vcsFor('jj').resolve(io, run, run.workers[1]!, '@-')).toEqual({ commit: FULL, conflict: true })
})

test('jj does not resolve a revision that names more than one commit', async () => {
  const io = new FakeIo()
  io.answers[`jj -R /tmp/meld/r1/w1 --ignore-working-copy log --no-graph -r all() -T ${JJ_RESOLVE_TEMPLATE}`] = `${FULL} clean\n${OTHER} clean\n`
  const run = runOn('jj')
  expect(await vcsFor('jj').resolve(io, run, run.workers[0]!, 'all()')).toBeUndefined()
})

test('jj lanes leave out the working copy, which shows as edits when it is not empty', async () => {
  const io = new FakeIo()
  io.answers[jjLog('w1')] = `${FULL}\t1\t--\tw1@\t\n${OTHER}\t1\tc-\t\tw1: status\n`
  io.answers[jjLog('w2')] = `${FULL}\t1\t-e\tw2@\t\n`
  const lanes = await vcsFor('jj').lanes(io, runOn('jj'))
  expect(lanes).toEqual([
    { id: 'w1', commits: [{ commit: OTHER, subject: 'w1: status', parents: 1, conflict: true }], edits: true },
    { id: 'w2', commits: [], edits: false },
  ])
})

test('a git lane that git cannot read names the error, so it does not pass for a lane with no work', async () => {
  const io = new FakeIo()
  io.failing = [`git log --format=%H%x09%P%x09%s -n 40 ${HEAD}..meld/r1/w2`]
  expect(await vcsFor('git').lanes(io, runOn('git'))).toStrictEqual([
    { id: 'w1', commits: [], edits: false },
    { id: 'w2', commits: [], edits: false, error: 'git: failed' },
  ])
  io.failing = ['git status']
  expect((await vcsFor('git').lanes(io, runOn('git'))).map(lane => lane.error)).toEqual(['git: failed', 'git: failed'])
})

test('a jj lane that jj cannot read names the error', async () => {
  const io = new FakeIo()
  io.failing = [jjLog('w1')]
  expect(await vcsFor('jj').lanes(io, runOn('jj'))).toStrictEqual([
    { id: 'w1', commits: [], edits: false, error: 'jj: failed' },
    { id: 'w2', commits: [], edits: false },
  ])
})

test('jj lanes with a snapshot read each workspace in its folder, so edits that no jj command recorded show', async () => {
  const io = new FakeIo()
  io.answers[`jj -R /tmp/meld/r1/w1 log --no-graph --limit 40 -r meld_base..w1@ -T ${JJ_LANE_TEMPLATE}`] = `${FULL}\t1\t--\tw1@\t\n`
  const lanes = await vcsFor('jj').lanes(io, runOn('jj'), { snapshot: true })
  expect(lanes).toEqual([
    { id: 'w1', commits: [], edits: true },
    { id: 'w2', commits: [], edits: false },
  ])
  expect(io.ran(`jj -R ${JJ_REPO}`)).toBe(false)
})

test('git lanes read the files of each worktree with or without a snapshot', async () => {
  const io = new FakeIo()
  io.dirty = true
  const lanes = await vcsFor('git').lanes(io, runOn('git'), { snapshot: true })
  expect(lanes.map(lane => lane.edits)).toEqual([true, true])
})

test('jj delivers through a bookmark in the store, a fetch and a merge commit', async () => {
  const io = new FakeIo()
  expect((await vcsFor('jj').deliver(io, runOn('jj'), FULL, 'meld: Add a dark theme')).ok).toBe(true)
  const delivery = io.commands.filter(command => !command.startsWith('git status'))
  expect(delivery).toEqual([
    `jj -R ${JJ_REPO} --ignore-working-copy bookmark set meld_final -r ${FULL} --allow-backwards`,
    `jj -R ${JJ_REPO} --ignore-working-copy git export`,
    `git fetch -q --no-tags ${STORE} refs/heads/meld_final`,
    `git merge --no-ff -m meld: Add a dark theme ${FULL}`,
  ])
})

test('jj removal drops the run folder and the repository config of jj', async () => {
  const io = new FakeIo()
  io.answers[`jj -R ${JJ_REPO} config path --repo`] = CONFIG
  await vcsFor('jj').remove(io, runOn('jj'))
  expect(io.commands).toContain('rm -rf -- /root/.config/jj/repos/42ee0e08c27ca3c2d862')
  expect(io.commands).toContain('rm -rf -- /tmp/meld/r1')
})

test('jj removal leaves a config path that is not a repository config of jj', async () => {
  const io = new FakeIo()
  io.answers[`jj -R ${JJ_REPO} config path --repo`] = '/root/.config/jj/config.toml'
  await vcsFor('jj').remove(io, runOn('jj'))
  expect(io.commands).not.toContain('rm -rf -- /root/.config/jj')
})

test('removal refuses a run id that could leave the meld folder', async () => {
  const io = new FakeIo()
  await vcsFor('git').remove(io, { ...runOn('git'), id: '../home' })
  expect(io.ran('rm')).toBe(false)
})

const LINE = 'c'.repeat(40)
const TREE = 'd'.repeat(40)
const MERGED = '9'.repeat(40)
const GIT_LINE = 'refs/heads/meld/r1/integration'
const JJ_LINE = 'refs/heads/meld_integration'
const MESSAGE = 'meld: integrate #3 Add the theme switch'

/** The answers of git for a merge of FULL into a line at LINE that neither holds the other. */
function lineAnswers(io: FakeIo, ref: string, identity = ''): void {
  io.answers[`git rev-parse --verify --quiet ${ref}^{commit}`] = LINE
  io.failing = [`git merge-base --is-ancestor ${FULL} ${LINE}`, `git merge-base --is-ancestor ${LINE} ${FULL}`]
  io.answers[`git merge-tree --write-tree --name-only --no-messages ${LINE} ${FULL}`] = TREE
  io.answers[`git ${identity}commit-tree ${TREE} -p ${LINE} -p ${FULL} -m ${MESSAGE}`] = MERGED
}

test('each adapter names the integration line as a worker names it in its folder', () => {
  expect(vcsFor('git').lineName(runOn('git'))).toBe('meld/r1/integration')
  expect(vcsFor('jj').lineName(runOn('jj'))).toBe('meld_integration')
})

test('git merges a finished commit into the integration line with a merge commit and no worktree', async () => {
  const io = new FakeIo()
  lineAnswers(io, GIT_LINE)
  expect(await vcsFor('git').mergeIntoLine(io, runOn('git'), FULL, MESSAGE)).toEqual({ state: 'merged', head: MERGED })
  expect(io.commands).toContain(`git update-ref ${GIT_LINE} ${MERGED} ${LINE}`)
  expect(io.cwds[`git merge-tree --write-tree --name-only --no-messages ${LINE} ${FULL}`]).toBe('/repo')
  expect(io.ran('git merge ')).toBe(false)
  expect(io.ran('git checkout')).toBe(false)
})

test('git starts the integration line at the base, and moves it forward to a commit that holds it', async () => {
  const io = new FakeIo()
  io.failing = [`git rev-parse --verify --quiet ${GIT_LINE}`, `git merge-base --is-ancestor ${FULL} ${HEAD}`]
  expect(await vcsFor('git').mergeIntoLine(io, runOn('git'), FULL, MESSAGE)).toEqual({ state: 'merged', head: FULL })
  expect(io.commands).toContain(`git update-ref ${GIT_LINE} ${FULL} `)
  expect(io.ran('git merge-tree')).toBe(false)
  expect(io.ran('git commit-tree')).toBe(false)
})

test('a commit that the integration line holds leaves the line as it is', async () => {
  const io = new FakeIo()
  io.answers[`git rev-parse --verify --quiet ${GIT_LINE}^{commit}`] = LINE
  expect(await vcsFor('git').mergeIntoLine(io, runOn('git'), FULL, MESSAGE)).toEqual({ state: 'merged', head: LINE })
  expect(io.ran('git update-ref')).toBe(false)
})

test('a conflict leaves the integration line where it was, and names the files', async () => {
  const io = new FakeIo()
  lineAnswers(io, GIT_LINE)
  io.outcomes[`git merge-tree --write-tree --name-only --no-messages ${LINE} ${FULL}`] = { exitCode: 1, stdout: `${TREE}\nsrc/a.ts\nsrc/b.ts\n`, stderr: '' }
  expect(await vcsFor('git').mergeIntoLine(io, runOn('git'), FULL, MESSAGE)).toEqual({ state: 'conflict', head: LINE, files: ['src/a.ts', 'src/b.ts'] })
  expect(io.ran('git commit-tree')).toBe(false)
  expect(io.ran('git update-ref')).toBe(false)
})

test('a merge that git cannot make fails, and the line stays', async () => {
  const io = new FakeIo()
  lineAnswers(io, GIT_LINE)
  io.failing.push('git merge-tree')
  expect(await vcsFor('git').mergeIntoLine(io, runOn('git'), FULL, MESSAGE)).toEqual({ state: 'failed', error: 'git: failed' })
  expect(io.ran('git update-ref')).toBe(false)
})

test('a line that moved since the merge read it fails the merge', async () => {
  const io = new FakeIo()
  lineAnswers(io, GIT_LINE)
  io.failing.push(`git update-ref ${GIT_LINE}`)
  expect(await vcsFor('git').mergeIntoLine(io, runOn('git'), FULL, MESSAGE)).toEqual({ state: 'failed', error: 'git: failed' })
})

test('jj merges in its store, with the identity of the repository, and gives jj the line as a bookmark', async () => {
  const io = new FakeIo()
  io.answers[`jj -R ${JJ_REPO} --ignore-working-copy log --no-graph -r ${FULL} -T ${JJ_RESOLVE_TEMPLATE}`] = `${FULL} clean\n`
  io.answers['git config user.name'] = 'Sample Person'
  io.answers['git config user.email'] = 'sample@example.com'
  lineAnswers(io, JJ_LINE, '-c user.name=Sample Person -c user.email=sample@example.com ')
  expect(await vcsFor('jj').mergeIntoLine(io, runOn('jj'), FULL, MESSAGE)).toEqual({ state: 'merged', head: MERGED })
  expect(io.cwds[`git merge-tree --write-tree --name-only --no-messages ${LINE} ${FULL}`]).toBe(STORE)
  expect(io.cwds[`git update-ref ${JJ_LINE} ${MERGED} ${LINE}`]).toBe(STORE)
  expect(io.commands.at(-1)).toBe(`jj -R ${JJ_REPO} --ignore-working-copy git import`)
})

test('jj does not merge a commit with a conflict into the integration line', async () => {
  const io = new FakeIo()
  io.answers[`jj -R ${JJ_REPO} --ignore-working-copy log --no-graph -r ${FULL} -T ${JJ_RESOLVE_TEMPLATE}`] = `${FULL} conflict\n`
  lineAnswers(io, JJ_LINE)
  expect(await vcsFor('jj').mergeIntoLine(io, runOn('jj'), FULL, MESSAGE)).toEqual({ state: 'conflict', head: LINE, files: [] })
  expect(io.ran('git merge-tree')).toBe(false)
  expect(io.ran('git update-ref')).toBe(false)
})

test('git removal drops the integration line', async () => {
  const io = new FakeIo()
  await vcsFor('git').remove(io, runOn('git'))
  expect(io.commands).toContain('git branch -D meld/r1/integration')
})
