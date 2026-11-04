import type { CommitFact, LaneFacts, ResultFacts, Run, VcsKind, Worker, WorkerId } from '../types'
import { command, git, gitChange, mergeInto } from './git'
import type { CommandResult } from './git'
import type { Io } from './io'

export const MELD_ROOT = '/tmp/meld'
export const JJ_RESOLVE_TEMPLATE = 'commit_id ++ " " ++ if(conflict, "conflict", "clean") ++ "\\n"'
export const JJ_LANE_TEMPLATE =
  'commit_id ++ "\\t" ++ parents.len() ++ "\\t" ++ if(conflict, "c", "-") ++ if(empty, "e", "-") ++ "\\t" ++ working_copies ++ "\\t" ++ description.first_line() ++ "\\n"'

const JJ_MIN_MINOR = 40
const LANE_LIMIT = '40'
/** What jj warns, and still exits 0, when a snapshot leaves out a new file, as one over snapshot.max-new-file-size (1 MiB). */
const JJ_REFUSED = 'Refused to snapshot'
/** A run id: lowercase letters and digits only, so a path made of it stays in the folder of meld. */
export const SAFE_ID = /^[0-9a-z]+$/
const FULL_COMMIT = /^[0-9a-f]{40}$/
const JJ_CONFIG_FOLDER = /^(.+\/repos\/[0-9a-f]{8,64})\/config\.toml$/
const BASE_BOOKMARK = 'meld_base'
const FINAL_BOOKMARK = 'meld_final'
const LINE_BOOKMARK = 'meld_integration'

export type Place = { id: string; repo: string; base: string }
export type Workspace = { path: string; ref: string }
export type Prepared = { workspaces: Workspace[] } | { error: string }
export type Resolved = { commit: string; conflict: boolean }
export type LaneRead = { snapshot?: boolean }
/**
 * A merge into the integration line: merged, with the head of the line (the same head when the line holds the commit);
 * a conflict, with the head that stays and the files in conflict; or failed, with the reason.
 */
export type LineMerge = { state: 'merged'; head: string } | { state: 'conflict'; head: string; files: string[] } | { state: 'failed'; error: string }

/** What meld asks of a version control: workspaces for the workers, the commits they name, the facts the pane shows, and the delivery. */
export type Vcs = {
  kind: VcsKind
  commitHint: string
  prepare(io: Io, place: Place, ids: WorkerId[]): Promise<Prepared>
  resolve(io: Io, run: Run, worker: Worker, revision: string): Promise<Resolved | undefined>
  /**
   * The commits of each worker since the base, and its uncommitted edits. jj records the files of a workspace only when a
   * jj command runs there, so a lane shows them as of that command; with snapshot, jj first records them. git reads the
   * files, new files too. A lane that meld cannot read, or whose snapshot left out a new file, names the error.
   */
  lanes(io: Io, run: LanePlace, read?: LaneRead): Promise<LaneFacts[]>
  result(io: Io, run: Run, commit: string): Promise<ResultFacts>
  /**
   * The commits of `commits` that `final` does not hold, as git merge-base --is-ancestor reads them: in the repository of
   * the person for git, in the store of the run for jj. A commit that git cannot read counts as missing.
   */
  missing(io: Io, run: Run, final: string, commits: readonly string[]): Promise<string[]>
  /** The integration line as a worker names it in its folder: a branch for git, a bookmark for jj. */
  lineName(run: Run): string
  /**
   * Merges a finished commit into the integration line with no working copy, so no agent and no folder of a worker takes
   * part. The line starts at the base. A line that the commit holds moves forward to it. Run one merge at a time: the ref
   * moves only from the head that the merge read, so a merge that lost a race fails and changes nothing.
   */
  mergeIntoLine(io: Io, run: Run, commit: string, message: string): Promise<LineMerge>
  /**
   * Moves the integration line to `commit`, from wherever it is, and makes it when the run has none. A steer of a ready run
   * moves it to the final commit, so the merges after the steer and the next final build on that commit.
   */
  setLine(io: Io, run: Run, commit: string): Promise<CommandResult>
  deliver(io: Io, run: Run, commit: string, message: string): Promise<CommandResult>
  remove(io: Io, run: RunPlace): Promise<void>
  /** The workspace of a worker that joins a live run: from the head of the integration line, or from the base when the run has no line. */
  addWorkspace(io: Io, run: Run, id: WorkerId): Promise<Workspace | { error: string }>
  /**
   * The commits that the lanes do not show. git: the commits on the HEAD of each worktree, as on a detached HEAD. jj: the
   * commits that no working copy holds, as the edits that an agent left before the next agent ran jj new.
   */
  strayWork(io: Io, run: LanePlace): Promise<StrayWork>
}

/** What meld could not read of the work of a run: a worker or the jj repository of the run, and the error. */
export type Unread = { id: string; error: string }

/** The commits that the lanes of a run do not show, and the reads that failed. */
export type StrayWork = { commits: string[]; unread: Unread[] }

export function runHome(id: string): string {
  return `${MELD_ROOT}/${id}`
}

function workspacePath(id: string, worker: WorkerId): string {
  return `${runHome(id)}/${worker}`
}

function storeOf(id: string): string {
  return `${runHome(id)}/store.git`
}

function jjRepoOf(id: string): string {
  return `${runHome(id)}/jj`
}

/** jj when jj 0.40 or newer answers in the repository, else git. */
export async function detectVcs(io: Io, repo: string): Promise<VcsKind> {
  const version = await command(io, repo, ['jj', '--version'])
  return version.ok && isRecentJj(version.out) ? 'jj' : 'git'
}

function isRecentJj(text: string): boolean {
  const match = /jj (\d+)\.(\d+)/.exec(text)
  if (!match) return false
  return Number(match[1]) > 0 || Number(match[2]) >= JJ_MIN_MINOR
}

export function vcsFor(kind: VcsKind): Vcs {
  return kind === 'jj' ? JJ : GIT
}

/** What a removal needs of a run: its id, the repository of the person, and the workspace of each worker. */
export type RunPlace = { id: string; repo: string; workers: readonly Workspace[] }

/** What a read of the lanes needs of a run: its id, the repository of the person, the base, and each worker with its workspace. */
export type LanePlace = { id: string; repo: string; base: string; workers: readonly (Workspace & { id: WorkerId })[] }

/** The work in the workspaces of a run: its commits since the base, the workers with uncommitted edits, and what meld cannot read. */
export type HeldWork = { commits: number; edits: WorkerId[]; unread: Unread[] }

/** The workspace of a worker of the run `id`: the folder and the ref that prepare makes for it. */
export function workspaceOf(kind: VcsKind, id: string, worker: WorkerId): Workspace {
  return { path: workspacePath(id, worker), ref: kind === 'jj' ? `${worker}@` : `meld/${id}/${worker}` }
}

/**
 * Reads the work in the workspaces of a run that no agent works in. jj first records the files of each workspace, as a
 * worker can stop after an edit and before its next jj command. The stray commits count too, after the lanes, so jj reads
 * the recorded files. A commit that two reads hold counts once.
 */
export async function heldWork(io: Io, run: LanePlace & { vcs: VcsKind }): Promise<HeldWork> {
  const vcs = vcsFor(run.vcs)
  const lanes = await vcs.lanes(io, run, { snapshot: true })
  const stray = await vcs.strayWork(io, run)
  const unreadLanes = lanes.flatMap(lane => (lane.error === undefined ? [] : [{ id: lane.id, error: lane.error }]))
  return {
    commits: new Set([...lanes.flatMap(lane => lane.commits.map(fact => fact.commit)), ...stray.commits]).size,
    edits: lanes.filter(lane => lane.edits).map(lane => lane.id),
    unread: [...unreadLanes, ...stray.unread],
  }
}

/**
 * Removes the folder of a run; an id with anything but lowercase letters and digits removes nothing. The rm runs in the
 * folder of meld, so that a run whose repository is gone still loses its folder.
 */
export async function removeFolder(io: Io, id: string): Promise<void> {
  if (SAFE_ID.test(id)) await command(io, MELD_ROOT, ['rm', '-rf', '--', runHome(id)])
}

async function dropWorktree(io: Io, repo: string, workspace: Workspace): Promise<void> {
  await git(io, repo, ['worktree', 'remove', '--force', workspace.path])
  await git(io, repo, ['branch', '-D', workspace.ref])
}

/** The git ref of the integration line of a git run: a branch next to the branches of the workers. */
function gitLine(run: { id: string }): string {
  return `meld/${run.id}/integration`
}

/**
 * Merges `commit` into the line at `ref` in the git store `gitDir`, with plumbing only: merge-tree makes the tree, commit-tree
 * the merge commit, and update-ref moves the line from the head it read. `config` gives git options, such as an identity.
 */
async function mergeInGit(io: Io, gitDir: string, ref: string, base: string, commit: string, message: string, config: string[] = []): Promise<LineMerge> {
  const found = await headOf(io, gitDir, ref)
  const head = found ?? base
  if ((await git(io, gitDir, ['merge-base', '--is-ancestor', commit, head])).ok) return { state: 'merged', head }
  let next = commit
  if (!(await git(io, gitDir, ['merge-base', '--is-ancestor', head, commit])).ok) {
    const merged = await git(io, gitDir, ['merge-tree', '--write-tree', '--name-only', '--no-messages', head, commit])
    const [tree = '', ...files] = merged.out.split('\n')
    if (!FULL_COMMIT.test(tree)) return { state: 'failed', error: merged.err || merged.out || 'git merge-tree made no tree' }
    if (!merged.ok) return { state: 'conflict', head, files: files.filter(Boolean) }
    const made = await git(io, gitDir, [...config, 'commit-tree', tree, '-p', head, '-p', commit, '-m', message])
    if (!made.ok || !FULL_COMMIT.test(made.out)) return { state: 'failed', error: made.err || made.out || 'git commit-tree made no commit' }
    next = made.out
  }
  const moved = await git(io, gitDir, ['update-ref', ref, next, found ?? ''])
  return moved.ok ? { state: 'merged', head: next } : { state: 'failed', error: moved.err || moved.out }
}

/** The commit of a ref in the git store `gitDir`, or undefined when the ref is not there yet. */
async function headOf(io: Io, gitDir: string, ref: string): Promise<string | undefined> {
  const found = await git(io, gitDir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  return found.ok && FULL_COMMIT.test(found.out) ? found.out : undefined
}

/** The identity of the repository of the person as git options, for a commit that meld makes in the store of jj. */
async function identityOf(io: Io, repo: string): Promise<string[]> {
  const name = await git(io, repo, ['config', 'user.name'])
  const email = await git(io, repo, ['config', 'user.email'])
  return [...(name.ok && name.out ? ['-c', `user.name=${name.out}`] : []), ...(email.ok && email.out ? ['-c', `user.email=${email.out}`] : [])]
}

function gitCommits(out: string): CommitFact[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [commit = '', parents = '', subject = ''] = line.split('\t')
      return { commit, subject, parents: parents.split(' ').filter(Boolean).length, conflict: false }
    })
}

/** The commits of `commits` that `final` does not hold in the git store `gitDir`, each one time, in their order. */
async function missingIn(io: Io, gitDir: string, final: string, commits: readonly string[]): Promise<string[]> {
  const missing: string[] = []
  for (const commit of new Set(commits)) if (!(await git(io, gitDir, ['merge-base', '--is-ancestor', commit, final])).ok) missing.push(commit)
  return missing
}

const GIT: Vcs = {
  kind: 'git',
  commitHint: 'Commit your work, then give HEAD or the commit hash.',

  async prepare(io, place, ids) {
    const made: Workspace[] = []
    for (const id of ids) {
      const workspace = workspaceOf('git', place.id, id)
      const added = await git(io, place.repo, ['worktree', 'add', '-b', workspace.ref, workspace.path, place.base])
      if (!added.ok) {
        for (const one of made) await dropWorktree(io, place.repo, one)
        return { error: added.err || added.out }
      }
      made.push(workspace)
    }
    return { workspaces: made }
  },

  async addWorkspace(io, run, id) {
    const workspace = workspaceOf('git', run.id, id)
    const added = await git(io, run.repo, ['worktree', 'add', '-b', workspace.ref, workspace.path, run.line?.head ?? run.base])
    return added.ok ? workspace : { error: added.err || added.out }
  },

  async resolve(io, run, worker, revision) {
    const found = await git(io, worker.path, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`])
    return found.ok && FULL_COMMIT.test(found.out) ? { commit: found.out, conflict: false } : undefined
  },

  /**
   * git status lists each new file: with status.showUntrackedFiles=no, a plain git status --porcelain hides them, and a
   * workspace whose only work is new files would read as one with no work.
   */
  async lanes(io, run) {
    const lanes: LaneFacts[] = []
    for (const worker of run.workers) {
      const log = await git(io, run.repo, ['log', '--format=%H%x09%P%x09%s', '-n', LANE_LIMIT, `${run.base}..${worker.ref}`])
      const status = await git(io, worker.path, ['status', '--porcelain', '--untracked-files=all'])
      const lane = { id: worker.id, commits: log.ok ? gitCommits(log.out) : [], edits: status.ok && status.out.length > 0 }
      const failed = [log, status].find(read => !read.ok)
      lanes.push(failed ? { ...lane, error: failed.err || failed.out } : lane)
    }
    return lanes
  },

  result: (io, run, commit) => gitChange(io, run.repo, run.base, commit),

  missing: (io, run, final, commits) => missingIn(io, run.repo, final, commits),

  lineName: gitLine,

  mergeIntoLine: (io, run, commit, message) => mergeInGit(io, run.repo, `refs/heads/${gitLine(run)}`, run.base, commit, message),

  setLine: (io, run, commit) => git(io, run.repo, ['update-ref', `refs/heads/${gitLine(run)}`, commit]),

  deliver: (io, run, commit, message) => mergeInto(io, run.repo, commit, message),

  /**
   * A removal names no workspace folder to git: git worktree remove follows a folder that is a link to the worktree that it
   * points to. So meld removes the folder of the run, which rm does not follow, prunes the worktrees whose folders are
   * gone, then drops the branches that they held.
   */
  async remove(io, run) {
    if (!SAFE_ID.test(run.id)) return
    await removeFolder(io, run.id)
    await git(io, run.repo, ['worktree', 'prune'])
    for (const worker of run.workers) await git(io, run.repo, ['branch', '-D', worker.ref])
    await git(io, run.repo, ['branch', '-D', gitLine(run)])
  },

  /** The log of each worktree from its HEAD and its branch, in the worktree, so a commit on a detached HEAD counts. */
  async strayWork(io, run) {
    const stray: StrayWork = { commits: [], unread: [] }
    for (const worker of run.workers) {
      const log = await git(io, worker.path, ['log', '--format=%H%x09%P%x09%s', '-n', LANE_LIMIT, `^${run.base}`, worker.ref, 'HEAD'])
      if (log.ok) stray.commits.push(...gitCommits(log.out).map(fact => fact.commit))
      else stray.unread.push({ id: worker.id, error: log.err || log.out })
    }
    return stray
  },
}

/**
 * jj works over a private git store of its own: `git init --bare`, the objects of the repository through
 * alternates, and one ref for the base. So the jj refs never reach the repository of the person, and nothing is copied.
 */
const JJ: Vcs = {
  kind: 'jj',
  commitHint: 'Run jj commit -m, then give @- or the commit id.',

  async prepare(io, place, ids) {
    const made = await makeJjRepo(io, place)
    if ('error' in made) {
      await removeJj(io, place.id)
      return made
    }
    const workspaces: Workspace[] = []
    for (const id of ids) {
      const workspace = workspaceOf('jj', place.id, id)
      const added = await command(io, place.repo, ['jj', '-R', jjRepoOf(place.id), 'workspace', 'add', '--name', id, '-r', BASE_BOOKMARK, workspace.path])
      if (!added.ok) {
        await removeJj(io, place.id)
        return { error: added.err || added.out }
      }
      workspaces.push(workspace)
    }
    return { workspaces }
  },

  async addWorkspace(io, run, id) {
    const workspace = workspaceOf('jj', run.id, id)
    const added = await command(io, run.repo, ['jj', '-R', jjRepoOf(run.id), 'workspace', 'add', '--name', id, '-r', run.line?.head ?? BASE_BOOKMARK, workspace.path])
    return added.ok ? workspace : { error: added.err || added.out }
  },

  async resolve(io, run, worker, revision) {
    const found = await command(io, worker.path, ['jj', '-R', worker.path, '--ignore-working-copy', 'log', '--no-graph', '-r', revision, '-T', JJ_RESOLVE_TEMPLATE])
    const lines = found.ok ? found.out.split('\n').filter(Boolean) : []
    const [commit = '', state = ''] = lines.length === 1 ? (lines[0] ?? '').split(' ') : []
    return FULL_COMMIT.test(commit) ? { commit, conflict: state === 'conflict' } : undefined
  },

  /**
   * A lane with snapshot runs jj in the folder of the worker, which records its files first; else jj reads the repository
   * as it is. A snapshot that left out a new file, as one over snapshot.max-new-file-size, makes the lane not readable:
   * jj still exits 0, and the working copy shows no edit for that file.
   */
  async lanes(io, run, read) {
    const lanes: LaneFacts[] = []
    for (const worker of run.workers) {
      const from = read?.snapshot ? [worker.path] : [jjRepoOf(run.id), '--ignore-working-copy']
      const log = await command(io, run.repo, ['jj', '-R', ...from, 'log', '--no-graph', '--limit', LANE_LIMIT, '-r', `${BASE_BOOKMARK}..${worker.id}@`, '-T', JJ_LANE_TEMPLATE])
      const lane = jjLane(worker.id, log.ok ? log.out : '')
      const error = log.ok ? refusedSnapshot(log.err) : log.err || log.out
      lanes.push(error === undefined ? lane : { ...lane, error })
    }
    return lanes
  },

  result: (io, run, commit) => gitChange(io, storeOf(run.id), run.base, commit),

  /** jj keeps each commit in the git store of the run, so git reads the ancestors there. */
  missing: (io, run, final, commits) => missingIn(io, storeOf(run.id), final, commits),

  lineName: () => LINE_BOOKMARK,

  /**
   * The line is a ref of the store that jj imports as a bookmark, so each workspace sees it. A commit with a conflict of jj
   * holds the sides of the conflict in its tree, so it is not merged: it counts as a conflict.
   */
  async mergeIntoLine(io, run, commit, message) {
    const store = storeOf(run.id)
    const ref = `refs/heads/${LINE_BOOKMARK}`
    const state = await command(io, run.repo, ['jj', '-R', jjRepoOf(run.id), '--ignore-working-copy', 'log', '--no-graph', '-r', commit, '-T', JJ_RESOLVE_TEMPLATE])
    if (!state.ok) return { state: 'failed', error: state.err || state.out }
    if (state.out.split('\n').some(line => line.endsWith(' conflict'))) return { state: 'conflict', head: (await headOf(io, store, ref)) ?? run.base, files: [] }
    const merged = await mergeInGit(io, store, ref, run.base, commit, message, await identityOf(io, run.repo))
    if (merged.state !== 'merged') return merged
    const imported = await command(io, run.repo, ['jj', '-R', jjRepoOf(run.id), '--ignore-working-copy', 'git', 'import'])
    return imported.ok ? merged : { state: 'failed', error: `the line moved to ${merged.head}, but jj did not import it: ${imported.err || imported.out}` }
  },

  /** The ref of the line in the store moves, and jj imports it, so each workspace sees the bookmark at `commit`. */
  async setLine(io, run, commit) {
    const moved = await git(io, storeOf(run.id), ['update-ref', `refs/heads/${LINE_BOOKMARK}`, commit])
    if (!moved.ok) return moved
    return command(io, run.repo, ['jj', '-R', jjRepoOf(run.id), '--ignore-working-copy', 'git', 'import'])
  },

  async deliver(io, run, commit, message) {
    const repo = jjRepoOf(run.id)
    const marked = await command(io, run.repo, ['jj', '-R', repo, '--ignore-working-copy', 'bookmark', 'set', FINAL_BOOKMARK, '-r', commit, '--allow-backwards'])
    if (!marked.ok) return marked
    const exported = await command(io, run.repo, ['jj', '-R', repo, '--ignore-working-copy', 'git', 'export'])
    if (!exported.ok) return exported
    const fetched = await git(io, run.repo, ['fetch', '-q', '--no-tags', storeOf(run.id), `refs/heads/${FINAL_BOOKMARK}`])
    if (!fetched.ok) return fetched
    return mergeInto(io, run.repo, commit, message)
  },

  remove: (io, run) => removeJj(io, run.id),

  /** The commits since the base that no working copy holds, with something in them: an empty commit holds no work. */
  async strayWork(io, run) {
    const revset = `${BASE_BOOKMARK}.. ~ ::working_copies()`
    const log = await command(io, run.repo, ['jj', '-R', jjRepoOf(run.id), '--ignore-working-copy', 'log', '--no-graph', '--limit', LANE_LIMIT, '-r', revset, '-T', JJ_LANE_TEMPLATE])
    if (!log.ok) return { commits: [], unread: [{ id: 'jj', error: log.err || log.out }] }
    const rows = log.out.split('\n').filter(Boolean).map(line => line.split('\t'))
    return { commits: rows.filter(([, , flags = '']) => !flags.includes('e')).map(([commit = '']) => commit), unread: [] }
  },
}

async function makeJjRepo(io: Io, place: Place): Promise<{ ok: true } | { error: string }> {
  const store = storeOf(place.id)
  const common = await git(io, place.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common.ok) return { error: common.err || common.out }
  const steps: [string, string[]][] = [
    [place.repo, ['git', 'init', '-q', '--bare', store]],
    [store, ['git', 'update-ref', `refs/heads/${BASE_BOOKMARK}`, place.base]],
    [place.repo, ['jj', 'git', 'init', '--git-repo', store, jjRepoOf(place.id)]],
  ]
  for (const [index, [cwd, argv]] of steps.entries()) {
    const done = await command(io, cwd, argv)
    if (!done.ok) return { error: done.err || done.out }
    if (index === 0) await io.writeFile(`${store}/objects/info/alternates`, `${common.out}/objects\n`)
  }
  const config = await command(io, place.repo, ['jj', '-R', jjRepoOf(place.id), 'config', 'path', '--repo'])
  if (!config.ok) return { error: config.err || config.out }
  const name = await git(io, place.repo, ['config', 'user.name'])
  const email = await git(io, place.repo, ['config', 'user.email'])
  await io.writeFile(config.out, jjConfig(place.id, name.ok ? name.out : '', email.ok ? email.out : ''))
  return { ok: true }
}

/** The first line of the repository config of jj that meld writes for the run `id`: a removal takes only a config with this line. */
export function jjConfigMark(id: string): string {
  return `# The repository config of the meld run ${id}`
}

/**
 * The repository config of jj for a run: the run, the identity of git, no editor (a command without -m fails at once), and
 * a base no worker can rewrite.
 */
function jjConfig(id: string, name: string, email: string): string {
  const user = [name && `name = ${JSON.stringify(name)}`, email && `email = ${JSON.stringify(email)}`].filter(Boolean)
  const sections = [
    jjConfigMark(id),
    user.length ? `[user]\n${user.join('\n')}` : '',
    `[revset-aliases]\n"immutable_heads()" = "builtin_immutable_heads() | ${BASE_BOOKMARK}"`,
    `[revsets]\nlog = "${BASE_BOOKMARK}::"`,
    '[ui]\neditor = "false"',
  ]
  return `${sections.filter(Boolean).join('\n\n')}\n`
}

/** Removes the repository config of jj, which jj keeps outside the run, then the folder; both run in the folder of meld, as removeFolder does. */
async function removeJj(io: Io, id: string): Promise<void> {
  if (!SAFE_ID.test(id)) return
  const folder = await configFolderOf(io, id)
  if (folder) await command(io, MELD_ROOT, ['rm', '-rf', '--', folder])
  await removeFolder(io, id)
}

/**
 * The folder of the repository config of the jj repository of the run `id`. jj finds the config through the store in the
 * jj folder of the run, and an agent can make a folder of the run, or that store, a link: jj then names the config of the
 * repository that the link points to. So meld gives the folder only when its config names the run.
 */
async function configFolderOf(io: Io, id: string): Promise<string | undefined> {
  const path = await command(io, MELD_ROOT, ['jj', '-R', jjRepoOf(id), 'config', 'path', '--repo'])
  const folder = path.ok ? JJ_CONFIG_FOLDER.exec(path.out)?.[1] : undefined
  if (!folder) return undefined
  const config = await command(io, MELD_ROOT, ['cat', '--', path.out])
  return config.ok && config.out.split('\n').includes(jjConfigMark(id)) ? folder : undefined
}

/**
 * Why a snapshot of jj left out new files, in one line: the warning, and the files that jj names under it with an indent.
 * Undefined when jj left out none, so the lane shows each file of the workspace.
 */
function refusedSnapshot(err: string): string | undefined {
  const lines = err.split('\n')
  const at = lines.findIndex(line => line.includes(JJ_REFUSED))
  if (at < 0) return undefined
  const after = lines.slice(at + 1)
  const end = after.findIndex(line => !/^\s/.test(line))
  const files = (end < 0 ? after : after.slice(0, end)).map(line => line.trim()).filter(Boolean)
  return [(lines[at] ?? '').replace(/^Warning:\s*/, '').trim(), files.join(', ')].filter(Boolean).join(' ')
}

function jjLane(id: WorkerId, out: string): LaneFacts {
  let edits = false
  const commits: CommitFact[] = []
  for (const line of out.split('\n').filter(Boolean)) {
    const [commit = '', parents = '0', flags = '--', copies = '', subject = ''] = line.split('\t')
    if (copies.split(' ').includes(`${id}@`)) edits = !flags.includes('e')
    else commits.push({ commit, subject, parents: Number(parents), conflict: flags.includes('c') })
  }
  return { id, commits, edits }
}
