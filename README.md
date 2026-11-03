# meld

Two Claude Code agents work on one task at the same time. Each one works in its own git worktree. They share a small task board, and one of them melds their work into one commit. You watch and steer them in a pane.

meld is a Claude Code plugin: one hooks module in TypeScript, with no native binary. It needs git. It was tested with Claude Code 2.1.317 on Linux.

## Install

At the prompt of a terminal session of Claude Code:

```
/plugin install meld --marketplace bhi5hmaraj/meld
```

Answer `y` to add the marketplace, then choose a scope.

From a shell:

```
claude plugin install meld --marketplace bhi5hmaraj/meld
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `bhi5hmaraj/meld`, then Add plugin.

## Use

| Command | What it does |
| --- | --- |
| `/meld <task>` | Starts two workers on the task, from the last commit of the repository you work in. |
| `/meld /path/to/repo <task>` | The same, in another repository. |
| `/meld-steer <instruction>` | Gives both workers a new instruction. The pane has a field for this too. |
| `/meld-status` | Opens the meld pane. |
| `/meld-stop` | Stops both workers. Their branches stay for review. |

The pane shows the task and your instructions, the two workers (state, last action, branch), the tasks with their owners, the log of notes and checks, and the result. Its buttons stop one worker or the run, deliver the result, or discard the run.

**Deliver** merges the final commit into your current branch with a merge commit, then removes the worktrees and branches. Your checkout must have no uncommitted changes. **Discard** removes the worktrees and branches with no merge.

What you type in the chat goes to Claude, not to the workers. To steer the workers, use the pane or `/meld-steer`.

## How it works

1. `/meld` makes two worktrees from `HEAD`, under `/tmp/meld/<run>/`, on the branches `meld/<run>/w1` and `meld/<run>/w2`.
2. Claude starts two forks of the conversation. meld puts each fork in its own worktree.
3. The workers plan the task as small tasks on the board, claim them, commit on their own branches, and share decisions with notes. A worker takes the commits of the other worker with `git merge` or `git cherry-pick`.
4. One worker takes the integration: it merges both branches, runs the checks, and declares the final commit. The run is then ready for you.
5. If you steer a ready run, the workers change the result and the run works again.

The workers use nine board tools: `board`, `add_tasks`, `claim`, `release`, `finish_task`, `note`, `check`, `integrate` and `finish`. meld knows each worker by the id that Claude Code gives the fork, not by a name the model writes.

The task list has a version. A worker adds its tasks in one call, with the version of its last board read. If the other worker added tasks since that read, the add fails and shows the current tasks, so the worker claims those that cover its work and adds only what is still missing. A claim is a compare-and-set on the task version, so two workers never claim one task.

meld refuses an edit that a worker makes outside its own worktree. When both workers are idle and no final commit is declared, meld wakes one of them with the next step, three times at most. Then it asks you to steer.

## What meld changes from DeLM

meld takes its idea from [DeLM](https://github.com/Decentralized-LM/delm-agent-plugin) (Decentralized Language Models, by Yuzhen Mao and Azalia Mirhoseini, MIT license). It is a new tool, not a port, with these changes:

- **TypeScript and git only.** Worktrees and branches replace the copy-on-write copies, and a git merge replaces the guarded file delivery. So it runs where git and Claude Code run, Linux included.
- **You steer only through the pane or `/meld-steer`.** A plain chat message never becomes a new task revision ([DeLM issue 18](https://github.com/Decentralized-LM/delm-agent-plugin/issues/18)).
- **A new instruction never fails a run or blocks a command.** A worker sees it at its next board call. A stale board call fails alone and tells the worker to read the board again ([DeLM issue 17](https://github.com/Decentralized-LM/delm-agent-plugin/issues/17)).
- **The task list has a version.** A stale add fails and shows the current tasks. DeLM's `task_create` has no such check, so two workers that plan at the same moment add the same work twice.
- **A run has five states:** starting, working, ready, delivered and stopped. No recovery state can hold a run.
- **A check is a record:** the command, the commit and the result. There are no check receipts and no preview ownership.

## Limits

- There are two workers.
- The workers start from your last commit. Commit first if they need your changes.
- The worktrees have no installed dependencies. The workers install them when their checks need them.
- The edit guard covers Edit, Write and NotebookEdit. A Bash command can still write in other folders, so the guard is a guard rail and not a sandbox.
- The plugin API of Claude Code is an early access API and can change between releases.

## Development

```
claude plugin validate .
claude plugin test .
```

`hooks/board.ts` holds the board rules as pure functions. `hooks/actions.ts` holds the steps of a run and takes an `Io` port. Only `hooks/register.tsx` calls the engine, because a hooks module spells `$` at its call sites only. The tests use a fake `Io` and mount the pane on each surface.

## License

MIT
