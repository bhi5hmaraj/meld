import type { Io } from './io'

export type GitResult = { ok: boolean; out: string; err: string }

export async function git(io: Io, cwd: string, args: string[]): Promise<GitResult> {
  try {
    const ran = await io.run(['git', ...args], cwd)
    return { ok: ran.exitCode === 0, out: ran.stdout.trim(), err: ran.stderr.trim() }
  } catch (error) {
    return { ok: false, out: '', err: String(error) }
  }
}

export async function repoRoot(io: Io, cwd: string): Promise<string | undefined> {
  const root = await git(io, cwd, ['rev-parse', '--show-toplevel'])
  return root.ok ? root.out : undefined
}

export async function headCommit(io: Io, repo: string): Promise<string> {
  return (await git(io, repo, ['rev-parse', 'HEAD'])).out
}

export async function isDirty(io: Io, repo: string): Promise<boolean> {
  return (await git(io, repo, ['status', '--porcelain'])).out.length > 0
}

export async function addWorktree(io: Io, repo: string, path: string, branch: string, base: string): Promise<GitResult> {
  return git(io, repo, ['worktree', 'add', '-b', branch, path, base])
}

export async function removeWorktree(io: Io, repo: string, path: string, branch: string): Promise<void> {
  await git(io, repo, ['worktree', 'remove', '--force', path])
  await git(io, repo, ['branch', '-D', branch])
}

export async function commitExists(io: Io, repo: string, commit: string): Promise<boolean> {
  return (await git(io, repo, ['cat-file', '-e', `${commit}^{commit}`])).ok
}

export async function mergeInto(io: Io, repo: string, commit: string, message: string): Promise<GitResult> {
  const merged = await git(io, repo, ['merge', '--no-ff', '-m', message, commit])
  if (!merged.ok) await git(io, repo, ['merge', '--abort'])
  return merged
}
