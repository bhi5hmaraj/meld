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
const SAFE_ID = /^[0-9a-z]+$/
const FULL_COMMIT = /^[0-9a-f]{40}$/
const JJ_CONFIG_FOLDER = /^(.+\/repos\/[0-9a-f]{8,64})\/config\.toml$/
const BASE_BOOKMARK = 'meld_base'
const FINAL_BOOKMARK = 'meld_final'

export type Place = { id: string; repo: string; base: string }
export type Workspace = { path: string; ref: string }
export type Prepared = { workspaces: Workspace[] } | { error: string }
export type Resolved = { commit: string; conflict: boolean }

/** What meld asks of a version control: workspaces for the workers, the commits they name, the facts the pane shows, and the delivery. */
export type Vcs = {
  kind: VcsKind
  commitHint: string
  prepare(io: Io, place: Place, ids: WorkerId[]): Promise<Prepared>
  resolve(io: Io, run: Run, worker: Worker, revision: string): Promise<Resolved | undefined>
  lanes(io: Io, run: Run): Promise<LaneFacts[]>
  result(io: Io, run: Run, commit: string): Promise<ResultFacts>
  deliver(io: Io, run: Run, commit: string, message: string): Promise<CommandResult>
  remove(io: Io, run: Run): Promise<void>
}

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

/** Removes the folder of a run; an id with anything but lowercase letters and digits removes nothing. */
async function removeHome(io: Io, place: { id: string; repo: string }): Promise<void> {
  if (SAFE_ID.test(place.id)) await command(io, place.repo, ['rm', '-rf', '--', runHome(place.id)])
}

async function dropWorktree(io: Io, repo: string, workspace: Workspace): Promise<void> {
  await git(io, repo, ['worktree', 'remove', '--force', workspace.path])
  await git(io, repo, ['branch', '-D', workspace.ref])
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

const GIT: Vcs = {
  kind: 'git',
  commitHint: 'Commit your work, then give HEAD or the commit hash.',

  async prepare(io, place, ids) {
    const made: Workspace[] = []
    for (const id of ids) {
      const workspace = { path: workspacePath(place.id, id), ref: `meld/${place.id}/${id}` }
      const added = await git(io, place.repo, ['worktree', 'add', '-b', workspace.ref, workspace.path, place.base])
      if (!added.ok) {
        for (const one of made) await dropWorktree(io, place.repo, one)
        return { error: added.err || added.out }
      }
      made.push(workspace)
    }
    return { workspaces: made }
  },

  async resolve(io, run, worker, revision) {
    const found = await git(io, worker.path, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`])
    return found.ok && FULL_COMMIT.test(found.out) ? { commit: found.out, conflict: false } : undefined
  },

  async lanes(io, run) {
    const lanes: LaneFacts[] = []
    for (const worker of run.workers) {
      const log = await git(io, run.repo, ['log', '--format=%H%x09%P%x09%s', '-n', LANE_LIMIT, `${run.base}..${worker.ref}`])
      const status = await git(io, worker.path, ['status', '--porcelain'])
      lanes.push({ id: worker.id, commits: log.ok ? gitCommits(log.out) : [], edits: status.ok && status.out.length > 0 })
    }
    return lanes
  },

  result: (io, run, commit) => gitChange(io, run.repo, run.base, commit),

  deliver: (io, run, commit, message) => mergeInto(io, run.repo, commit, message),

  async remove(io, run) {
    if (!SAFE_ID.test(run.id)) return
    for (const worker of run.workers) await dropWorktree(io, run.repo, worker)
    await removeHome(io, run)
    await git(io, run.repo, ['worktree', 'prune'])
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
      await removeJj(io, place)
      return made
    }
    const workspaces: Workspace[] = []
    for (const id of ids) {
      const path = workspacePath(place.id, id)
      const added = await command(io, place.repo, ['jj', '-R', jjRepoOf(place.id), 'workspace', 'add', '--name', id, '-r', BASE_BOOKMARK, path])
      if (!added.ok) {
        await removeJj(io, place)
        return { error: added.err || added.out }
      }
      workspaces.push({ path, ref: `${id}@` })
    }
    return { workspaces }
  },

  async resolve(io, run, worker, revision) {
    const found = await command(io, worker.path, ['jj', '-R', worker.path, '--ignore-working-copy', 'log', '--no-graph', '-r', revision, '-T', JJ_RESOLVE_TEMPLATE])
    const lines = found.ok ? found.out.split('\n').filter(Boolean) : []
    const [commit = '', state = ''] = lines.length === 1 ? (lines[0] ?? '').split(' ') : []
    return FULL_COMMIT.test(commit) ? { commit, conflict: state === 'conflict' } : undefined
  },

  async lanes(io, run) {
    const lanes: LaneFacts[] = []
    for (const worker of run.workers) {
      const log = await command(io, run.repo, [
        'jj',
        '-R',
        jjRepoOf(run.id),
        '--ignore-working-copy',
        'log',
        '--no-graph',
        '--limit',
        LANE_LIMIT,
        '-r',
        `${BASE_BOOKMARK}..${worker.id}@`,
        '-T',
        JJ_LANE_TEMPLATE,
      ])
      lanes.push(jjLane(worker.id, log.ok ? log.out : ''))
    }
    return lanes
  },

  result: (io, run, commit) => gitChange(io, storeOf(run.id), run.base, commit),

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

  remove: (io, run) => removeJj(io, run),
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
  await io.writeFile(config.out, jjConfig(name.ok ? name.out : '', email.ok ? email.out : ''))
  return { ok: true }
}

/** The repository config of jj for a run: the identity of git, no editor (a command without -m fails at once), a base no worker can rewrite. */
function jjConfig(name: string, email: string): string {
  const user = [name && `name = ${JSON.stringify(name)}`, email && `email = ${JSON.stringify(email)}`].filter(Boolean)
  const sections = [
    user.length ? `[user]\n${user.join('\n')}` : '',
    `[revset-aliases]\n"immutable_heads()" = "builtin_immutable_heads() | ${BASE_BOOKMARK}"`,
    `[revsets]\nlog = "${BASE_BOOKMARK}::"`,
    '[ui]\neditor = "false"',
  ]
  return `${sections.filter(Boolean).join('\n\n')}\n`
}

async function removeJj(io: Io, place: { id: string; repo: string }): Promise<void> {
  if (!SAFE_ID.test(place.id)) return
  const config = await command(io, place.repo, ['jj', '-R', jjRepoOf(place.id), 'config', 'path', '--repo'])
  const folder = config.ok ? JJ_CONFIG_FOLDER.exec(config.out)?.[1] : undefined
  if (folder) await command(io, place.repo, ['rm', '-rf', '--', folder])
  await removeHome(io, place)
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
