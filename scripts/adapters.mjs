#!/usr/bin/env node
/**
 * A check of the git and the jj adapter of hooks/vcs.ts with real processes. tsc compiles hooks/ into CommonJS in a
 * temporary folder. Each adapter goes through a run in a temporary git repository: three workspaces, a commit in
 * each, the integration line, the integration, resolve, lanes, result, deliver and remove. HOME is a temporary folder, so the check reads and
 * changes no git or jj config of the person. Run: node scripts/adapters.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const TEMP = mkdtempSync(join(tmpdir(), 'meld-adapters-'))
const HOME = join(TEMP, 'home')
const OUT = join(TEMP, 'out')
const NAME = 'meld check'
const EMAIL = 'check@example.com'
const IDS = ['w1', 'w2', 'w3']
const INTEGRATE = 'meld: integrate'
const TIMEOUT_MS = 120_000
const ENV = { ...process.env, HOME, XDG_CONFIG_HOME: join(HOME, '.config'), GIT_CONFIG_NOSYSTEM: '1' }
const STEPS = [
  ['repository', makeRepository],
  ['prepare', prepare],
  ['commit', commit],
  ['line', line],
  ['integrate', integrate],
  ['missing', missing],
  ['resolve', resolve],
  ['lanes', lanes],
  ['result', result],
  ['deliver', deliver],
  ['join', addWorkers],
  ['remove', remove],
]

const require = createRequire(import.meta.url)
const io = { run, writeFile }
let hooks
let failures = 0

async function run(argv, cwd) {
  const ran = spawnIn(cwd, argv)
  if (ran.error) throw ran.error
  return { exitCode: ran.status, stdout: ran.stdout, stderr: ran.stderr }
}

async function writeFile(path, text) {
  writeFileSync(path, text)
}

function spawnIn(cwd, argv) {
  return spawnSync(argv[0], argv.slice(1), { cwd, env: ENV, encoding: 'utf8', timeout: TIMEOUT_MS })
}

/** Runs a command of the check itself, not of an adapter, and gives its output; a command that fails stops the step. */
function sh(cwd, argv) {
  const ran = spawnIn(cwd, argv)
  if (ran.status !== 0) throw new Error(`${argv.join(' ')}: ${ran.error?.message ?? `${ran.stderr}${ran.stdout}`.trim()}`)
  return ran.stdout.trim()
}

function same(actual, expected, what) {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`${what} is ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}`)
}

function short(commit) {
  return commit.slice(0, 7)
}

async function step(name, action) {
  try {
    console.log(`PASS ${name}: ${await action()}`)
    return true
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

async function compile() {
  const config = join(TEMP, 'tsconfig.json')
  const compilerOptions = { target: 'es2023', module: 'commonjs', jsx: 'react', jsxFactory: 'h', jsxFragmentFactory: 'Fragment', noCheck: true, rootDir: PLUGIN, outDir: OUT }
  writeFileSync(config, JSON.stringify({ compilerOptions, include: [join(PLUGIN, 'hooks')] }))
  sh(PLUGIN, ['tsc', '-p', config])
  writeFileSync(join(OUT, 'package.json'), '{ "type": "commonjs" }\n')
  hooks = { vcs: require(join(OUT, 'hooks', 'vcs.js')), board: require(join(OUT, 'hooks', 'board.js')) }
  return `hooks/ in ${OUT}`
}

async function makeRepository(s) {
  sh(TEMP, ['git', 'init', '-q', '-b', 'main', s.repo])
  sh(s.repo, ['git', 'config', 'user.name', NAME])
  sh(s.repo, ['git', 'config', 'user.email', EMAIL])
  writeFileSync(join(s.repo, 'README.md'), '# check\n')
  sh(s.repo, ['git', 'add', '-A'])
  sh(s.repo, ['git', 'commit', '-q', '-m', 'base'])
  s.base = sh(s.repo, ['git', 'rev-parse', 'HEAD'])
  const made = `${s.repo} on main at ${short(s.base)}`
  if (s.kind === 'git') return made
  same(await hooks.vcs.detectVcs(io, s.repo), 'jj', 'the version control that meld detects')
  return `${made}; meld detects jj`
}

async function prepare(s) {
  const prepared = await s.vcs.prepare(io, { id: s.id, repo: s.repo, base: s.base }, IDS)
  if ('error' in prepared) throw new Error(prepared.error)
  same(prepared.workspaces.map(workspace => workspace.path), IDS.map(id => join(s.home, id)), 'the folders')
  for (const workspace of prepared.workspaces) if (!existsSync(join(workspace.path, 'README.md'))) throw new Error(`${workspace.path} has no files of the base`)
  const workers = prepared.workspaces.map((workspace, index) => ({ ...workspace, id: IDS[index], agent: { type: 'meld:worker' } }))
  s.run = hooks.board.startRun({ id: s.id, request: `Check ${s.kind}`, repo: s.repo, base: s.base, vcs: s.kind, now: Date.now(), workers })
  const made = `three workspaces from ${short(s.base)}: ${workers.map(worker => worker.ref).join(', ')}`
  if (s.kind === 'git') return made
  s.config = sh(s.repo, ['jj', '-R', join(s.home, 'jj'), 'config', 'path', '--repo'])
  if (spawnIn(workers[0].path, ['jj', 'describe', '-r', 'meld_base', '-m', 'rewrite']).status === 0) throw new Error('a worker can rewrite the base')
  return `${made}; the base cannot change`
}

async function commit(s) {
  for (const worker of s.run.workers) {
    writeFileSync(join(worker.path, `${worker.id}.txt`), `made by ${worker.id}\n`)
    s.commits[worker.id] = commitIn(s.kind, worker.path, `${worker.id}: add ${worker.id}.txt`)
  }
  if (s.kind === 'jj') same(sh(s.run.workers[0].path, ['jj', 'log', '--no-graph', '-r', '@-', '-T', 'author.email()']), EMAIL, 'the author of a jj commit')
  return IDS.map(id => `${id} ${short(s.commits[id])}`).join(', ')
}

function commitIn(kind, path, message) {
  if (kind === 'jj') {
    sh(path, ['jj', 'commit', '-m', message])
    return sh(path, ['jj', 'log', '--no-graph', '-r', '@-', '-T', 'commit_id'])
  }
  sh(path, ['git', 'add', '-A'])
  sh(path, ['git', 'commit', '-q', '-m', message])
  return sh(path, ['git', 'rev-parse', 'HEAD'])
}

/**
 * meld merges the commit of each finished task into the integration line, with no working copy: the first commit moves
 * the line forward, the others make merge commits, a commit that the line holds changes nothing, and a conflict leaves
 * the line where it was. A workspace sees the line under its name.
 */
async function line(s) {
  const name = s.vcs.lineName(s.run)
  let head = s.base
  for (const [index, id] of IDS.entries()) {
    const merged = await s.vcs.mergeIntoLine(io, s.run, s.commits[id], `meld: integrate #${index + 1}`)
    if (merged.state !== 'merged') throw new Error(`the merge of ${id} is ${JSON.stringify(merged)}`)
    if (index === 0) same(merged.head, s.commits.w1, 'the line after the first merge')
    head = merged.head
  }
  same(sh(s.repo, ['git', '--git-dir', gitDirOf(s), 'log', '-1', '--format=%P', head]).split(' ').length, 2, 'the parents of the head of the line')
  const files = sh(s.repo, ['git', '--git-dir', gitDirOf(s), 'ls-tree', '--name-only', head]).split('\n')
  same(files.filter(file => file.startsWith('w')), IDS.map(id => `${id}.txt`), 'the files of the line')
  same(await s.vcs.mergeIntoLine(io, s.run, s.commits.w2, 'meld: integrate #2 again'), { state: 'merged', head }, 'a second merge of w2')
  const seen = s.kind === 'jj' ? sh(s.run.workers[2].path, ['jj', 'log', '--no-graph', '-r', name, '-T', 'commit_id']) : sh(s.run.workers[2].path, ['git', 'rev-parse', name])
  same(seen, head, `${name} in the folder of w3`)
  const other = otherW1(s)
  same(await s.vcs.mergeIntoLine(io, s.run, other, 'meld: integrate #4'), { state: 'conflict', head, files: ['w1.txt'] }, 'a merge with a conflict')
  s.line = head
  s.other = other
  return `${name} moves to ${short(s.commits.w1)}, then merges w2 and w3 into ${short(head)}; a conflict in w1.txt leaves it there`
}

function gitDirOf(s) {
  return s.kind === 'jj' ? join(s.home, 'store.git') : join(s.repo, '.git')
}

/** A commit on the base with another w1.txt, which no lane shows: in the default workspace of jj, or a detached commit of git. */
function otherW1(s) {
  const path = s.kind === 'jj' ? join(s.home, 'jj') : s.run.workers[2].path
  if (s.kind === 'jj') {
    sh(path, ['jj', 'new', 'meld_base', '-m', 'another w1.txt'])
    writeFileSync(join(path, 'w1.txt'), 'made by another\n')
    return sh(path, ['jj', 'log', '--no-graph', '-r', '@', '-T', 'commit_id'])
  }
  sh(path, ['git', 'checkout', '-q', '--detach', s.base])
  writeFileSync(join(path, 'w1.txt'), 'made by another\n')
  const made = commitIn('git', path, 'another w1.txt')
  sh(path, ['git', 'checkout', '-q', s.run.workers[2].ref])
  return made
}

async function integrate(s) {
  const [first, ...peers] = s.run.workers
  if (s.kind === 'jj') {
    sh(first.path, ['jj', 'new', '@-', ...peers.map(peer => `${peer.id}@-`), '-m', INTEGRATE])
    s.final = commitIn('jj', first.path, INTEGRATE)
  } else {
    sh(first.path, ['git', 'merge', '-q', '--no-ff', '-m', INTEGRATE, ...peers.map(peer => peer.ref)])
    s.final = sh(first.path, ['git', 'rev-parse', 'HEAD'])
  }
  return `w1 merges w2 and w3 into ${short(s.final)}`
}

/** The final commit holds the commit of each worker, and lacks a commit that no worker merged; a commit that git cannot read counts as lacking. */
async function missing(s) {
  same(await s.vcs.missing(io, s.run, s.final, IDS.map(id => s.commits[id])), [], 'the commits that the final commit lacks')
  const unknown = '0'.repeat(40)
  same(await s.vcs.missing(io, s.run, s.final, [s.commits.w2, s.other, unknown]), [s.other, unknown], 'the commits that the final commit lacks, with two it does not hold')
  same(await s.vcs.missing(io, s.run, s.line, IDS.map(id => s.commits[id])), [], 'the commits that the line lacks')
  return `${short(s.final)} holds the commits of ${IDS.join(', ')}, and lacks ${short(s.other)} and a commit that git cannot read`
}

async function resolve(s) {
  const revision = s.kind === 'jj' ? '@-' : 'HEAD'
  const tips = [s.final, s.commits.w2, s.commits.w3]
  for (const [index, worker] of s.run.workers.entries()) {
    same(await s.vcs.resolve(io, s.run, worker, revision), { commit: tips[index], conflict: false }, `${revision} in the folder of ${worker.id}`)
  }
  same(await s.vcs.resolve(io, s.run, s.run.workers[0], 'nothere'), undefined, 'a revision that names no commit')
  if (s.kind === 'git') return `${revision} of each worker; nothing for a revision that names no commit`
  same(await s.vcs.resolve(io, s.run, s.run.workers[0], 'all()'), undefined, 'a revision that names many commits')
  const conflicted = conflictIn(join(s.home, 'jj'))
  same(await s.vcs.resolve(io, s.run, s.run.workers[0], conflicted), { commit: conflicted, conflict: true }, 'a commit with a conflict')
  same(await s.vcs.mergeIntoLine(io, s.run, conflicted, 'meld: integrate #5'), { state: 'conflict', head: s.line, files: [] }, 'a merge of a commit with a conflict')
  return `${revision} of each worker; nothing for a bad revision; the conflict of ${short(conflicted)}, which the line does not take`
}

/** Makes a commit with a conflict in the default workspace of the jj repository, where no worker sees it in its lane. */
function conflictIn(path) {
  const sides = ['a', 'b'].map(side => {
    sh(path, ['jj', 'new', 'meld_base', '-m', `side ${side}`])
    writeFileSync(join(path, 'side.txt'), `${side}\n`)
    return sh(path, ['jj', 'log', '--no-graph', '-r', '@', '-T', 'change_id'])
  })
  sh(path, ['jj', 'new', ...sides, '-m', 'both sides'])
  return sh(path, ['jj', 'log', '--no-graph', '-r', '@', '-T', 'commit_id'])
}

async function lanes(s) {
  const drafter = s.run.workers[1]
  writeFileSync(join(drafter.path, 'draft.txt'), 'not committed\n')
  if (s.kind === 'jj') sh(drafter.path, ['jj', 'status'])
  const found = await s.vcs.lanes(io, s.run)
  same(found.map(lane => [lane.id, lane.edits]), [['w1', false], ['w2', true], ['w3', false]], 'the lanes and their edits')
  same(found[0].commits[0], { commit: s.final, subject: INTEGRATE, parents: 3, conflict: false }, 'the newest commit of w1')
  same(found[0].commits.map(fact => fact.commit).sort(), [s.final, ...Object.values(s.commits)].sort(), 'the commits of w1')
  for (const [index, id] of ['w2', 'w3'].entries()) {
    same(found[index + 1].commits, [{ commit: s.commits[id], subject: `${id}: add ${id}.txt`, parents: 1, conflict: false }], `the commits of ${id}`)
  }
  writeFileSync(join(s.run.workers[2].path, 'late.txt'), 'edited after the last jj command\n')
  const read = await s.vcs.lanes(io, s.run, { snapshot: true })
  same(read.map(lane => [lane.id, lane.edits, lane.error]), [['w1', false, undefined], ['w2', true, undefined], ['w3', true, undefined]], 'the lanes and their edits with a snapshot')
  same(read[2].commits, found[2].commits, 'the commits of w3 with a snapshot')
  return 'w1 has the merge and the three commits; w2 and w3 have one commit; w2 has edits; with a snapshot, w3 has its new edit'
}

async function result(s) {
  const change = await s.vcs.result(io, s.run, s.final)
  same([change.commit, change.fileCount, change.added, change.removed], [s.final, 3, 3, 0], 'the commit, files, added and removed lines')
  same(change.files.map(file => file.path), IDS.map(id => `${id}.txt`), 'the files')
  same(change.files.map(file => file.patch), IDS.map(id => `--- /dev/null\n+++ b/${id}.txt\n@@ -0,0 +1 @@\n+made by ${id}`), 'the diffs')
  return `3 files and 3 added lines in ${short(s.final)}, each with its diff`
}

async function deliver(s) {
  const head = sh(s.repo, ['git', 'rev-parse', 'HEAD'])
  const message = `meld: check ${s.kind}`
  const merged = await s.vcs.deliver(io, s.run, s.final, message)
  if (!merged.ok) throw new Error(merged.err || merged.out)
  same(sh(s.repo, ['git', 'log', '-1', '--format=%P%n%s']), `${head} ${s.final}\n${message}`, 'the parents and subject of HEAD')
  same(sh(s.repo, ['git', 'ls-files', 'w*.txt']).split('\n'), IDS.map(id => `${id}.txt`), 'the delivered files')
  same(sh(s.repo, ['git', 'status', '--porcelain']), '', 'the status of the repository')
  return `a merge commit on main with ${short(s.final)} as its second parent`
}

/**
 * A worker joins the live run: w4 from the head of the integration line, with the files of the three workers, and w5 from
 * the base, with none. Both go on the board, so remove must drop them too.
 */
async function addWorkers(s) {
  const lined = { ...s.run, line: { head: s.line, tasks: [] } }
  const fromLine = await s.vcs.addWorkspace(io, lined, 'w4')
  if ('error' in fromLine) throw new Error(fromLine.error)
  same(IDS.filter(id => existsSync(join(fromLine.path, `${id}.txt`))), IDS, 'the files of the workers in w4')
  const fromBase = await s.vcs.addWorkspace(io, s.run, 'w5')
  if ('error' in fromBase) throw new Error(fromBase.error)
  same(IDS.filter(id => existsSync(join(fromBase.path, `${id}.txt`))), [], 'the files of the workers in w5')
  if (!existsSync(join(fromBase.path, 'README.md'))) throw new Error(`${fromBase.path} has no files of the base`)
  for (const [id, made] of [['w4', fromLine], ['w5', fromBase]]) s.run = hooks.board.addWorker(s.run, { ...made, id, agent: { type: 'meld:worker' } }, Date.now())
  same(s.run.workers.map(worker => worker.id), [...IDS, 'w4', 'w5'], 'the workers on the board')
  return `w4 from the line ${short(s.line)} has the files of w1, w2 and w3; w5 from the base has none`
}

async function remove(s) {
  await s.vcs.remove(io, s.run)
  if (existsSync(s.home)) throw new Error(`${s.home} stays`)
  if (s.config && existsSync(dirname(s.config))) throw new Error(`${dirname(s.config)} stays`)
  same(sh(s.repo, ['git', 'for-each-ref', '--format=%(refname)']), 'refs/heads/main', 'the refs of the repository')
  same(sh(s.repo, ['git', 'worktree', 'list', '--porcelain']).split('\n').filter(line => line.startsWith('worktree ')), [`worktree ${s.repo}`], 'the worktrees')
  return s.config ? 'no run folder, jj config, ref or worktree stays' : 'no run folder, branch or worktree stays'
}

async function checkAdapter(kind) {
  const id = `${kind}${Date.now().toString(36)}`
  const s = { kind, id, vcs: hooks.vcs.vcsFor(kind), home: hooks.vcs.runHome(id), repo: join(TEMP, kind), commits: {} }
  try {
    for (const [name, action] of STEPS) if (!(await step(`${kind} ${name}`, () => action(s)))) return
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
}

try {
  mkdirSync(HOME)
  if (await step('compile', compile)) {
    await checkAdapter('git')
    await checkAdapter('jj')
  }
} finally {
  rmSync(TEMP, { recursive: true, force: true })
}
process.exitCode = failures ? 1 : 0
