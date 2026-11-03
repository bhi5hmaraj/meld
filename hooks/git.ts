import type { FileChange, ResultFacts } from '../types'
import type { Io } from './io'

export type CommandResult = { ok: boolean; out: string; err: string; raw: string }

const FILE_LIMIT = 8
const PATCH_LINES = 160
const PATCH_CHARS = 16_000

/** Runs a host command; a command that cannot start fails like one that exits with an error. */
export async function command(io: Io, cwd: string, argv: string[]): Promise<CommandResult> {
  try {
    const ran = await io.run(argv, cwd)
    return { ok: ran.exitCode === 0, out: ran.stdout.trim(), err: ran.stderr.trim(), raw: ran.stdout }
  } catch (error) {
    return { ok: false, out: '', err: String(error), raw: '' }
  }
}

export function git(io: Io, cwd: string, args: string[]): Promise<CommandResult> {
  return command(io, cwd, ['git', ...args])
}

export async function repoRoot(io: Io, cwd: string): Promise<string | undefined> {
  const root = await git(io, cwd, ['rev-parse', '--show-toplevel'])
  return root.ok ? root.out : undefined
}

export async function headCommit(io: Io, repo: string): Promise<string> {
  return (await git(io, repo, ['rev-parse', 'HEAD'])).out
}

/** Whether the checkout holds changes, counting untracked files unless `untracked` is false. */
export async function isDirty(io: Io, cwd: string, { untracked = true } = {}): Promise<boolean> {
  const status = await git(io, cwd, ['status', '--porcelain', ...(untracked ? [] : ['--untracked-files=no'])])
  return status.ok && status.out.length > 0
}

export async function mergeInto(io: Io, repo: string, commit: string, message: string): Promise<CommandResult> {
  const merged = await git(io, repo, ['merge', '--no-ff', '-m', message, commit])
  if (!merged.ok) await git(io, repo, ['merge', '--abort'])
  return merged
}

/** The change from `base` to `commit` in the git store `gitDir`: totals of every file, hunks of the first files. */
export async function gitChange(io: Io, gitDir: string, base: string, commit: string): Promise<ResultFacts> {
  const stat = await git(io, gitDir, ['diff', '--no-renames', '--numstat', base, commit])
  const rows = stat.ok ? numstatRows(stat.out) : []
  const files: FileChange[] = []
  for (const row of rows.slice(0, FILE_LIMIT)) {
    const diff = await git(io, gitDir, ['diff', '--no-renames', base, commit, '--', row.path])
    files.push({ ...row, patch: hunksOf(diff.ok ? diff.raw : '') })
  }
  return {
    commit,
    files,
    fileCount: rows.length,
    added: rows.reduce((sum, row) => sum + row.added, 0),
    removed: rows.reduce((sum, row) => sum + row.removed, 0),
  }
}

function numstatRows(out: string): Omit<FileChange, 'patch'>[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [added = '0', removed = '0', ...path] = line.split('\t')
      return { path: path.join('\t'), added: Number(added) || 0, removed: Number(removed) || 0 }
    })
}

/**
 * The `---`/`+++` pair and the whole hunks of one file, as a `Code` diff draws them: no git headers, and no hunk
 * cut in the middle, so the diff still parses. A first hunk past the limits is kept alone; one past the characters is dropped.
 */
export function hunksOf(patch: string): string {
  const lines = patch.replace(/\n$/, '').split('\n')
  const start = lines.findIndex(line => line.startsWith('--- '))
  if (start < 0) return ''
  const kept = lines.slice(start, start + 2)
  let hunk: string[] = []
  for (const line of [...lines.slice(start + 2), '@@']) {
    if (line.startsWith('@@') && hunk.length) {
      if (kept.length > 2 && kept.length + hunk.length > PATCH_LINES) break
      kept.push(...hunk)
      hunk = []
    }
    hunk.push(line)
  }
  const text = kept.join('\n')
  return text.length > PATCH_CHARS || kept.length <= 2 ? '' : text
}
