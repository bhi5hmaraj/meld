# meld

Several Claude Code agents work on one task at the same time. Each agent works in its own jj workspace or git worktree. The agents share a small task board, and one of them melds their work into one commit. You watch and steer them in a pane.

meld is a Claude Code plugin: one hooks module in TypeScript, with no native binary. It needs git, and it uses jj 0.40 or newer when jj is installed. It was tested with Claude Code 2.1.317, jj 0.46 and git 2.43 on Linux.

## Install

At the prompt of a terminal session of Claude Code:

```
/plugin install meld --marketplace bhi5hmaraj/meld
```

Answer `y` to add the marketplace, and choose a scope.

From a shell:

```
claude plugin install meld --marketplace bhi5hmaraj/meld
```

The desktop app does not run `/plugin`. In the desktop app, click + next to the prompt box and click Plugins. Click Add marketplace, type `bhi5hmaraj/meld`, and click Add plugin.

## Use

| Command | What it does |
| --- | --- |
| `/meld <task>` | Starts two workers on the task, from the last commit of the repository you work in. |
| `/meld --agents 3 <task>` | Starts three workers. A run has 1 to 8 workers. |
| `/meld --agents opus,general-purpose@haiku,sonnet <task>` | Starts one worker for each item of the list. |
| `/meld --model sonnet <task>` | Starts the workers on the model `sonnet`. |
| `/meld --vcs git <task>` | Makes git worktrees for the workers. `--vcs jj` makes jj workspaces. `--vcs auto` is the default: it uses jj when jj is installed, and git when it is not. |
| `/meld /path/to/repo <task>` | Starts the run in another repository. |
| `/meld-steer <instruction>` | Gives every worker a new instruction. The pane has a field and preset buttons for the same purpose. If every worker has ended, meld restarts them with it. |
| `/meld-status` | Opens the meld pane. |
| `/meld-stop` | Stops every worker. Their workspaces stay for review. |

The options come before the task, in any order: `/meld --agents 3 --model sonnet --vcs git /path/to/repo Add a dark theme`.

An item of the `--agents` list is one of these:

- A model: `opus`, `sonnet`, `haiku`, `fable`, or a model id that starts with `claude-`. meld starts a `meld:worker` on that model.
- An agent type: `general-purpose`, or an agent of a plugin. meld starts a worker of that type.
- A type and a model, with `@` between them: `general-purpose@haiku`.

`--model` gives its model to each worker that names no model. `--model inherit` is the default: meld names no model, and each worker uses the model of its agent type. A type with no model, such as `meld:worker`, uses the model of your session. The list item `general-purpose@inherit` runs that type on the model of your session.

meld starts each worker itself, as the hidden agent type `meld:worker`, in the folder of that worker. The type is not in the list of agent types that Claude sees. A run starts from `/meld`, from the Start button of the pane, or from the `start` tool of the main session.

You can ask for a run in the chat: Claude calls the `start` tool, with the same options as `/meld`. When you ask Claude to change the request, it calls the `steer` tool, and when you ask Claude to stop the run, it calls the `stop` tool. These three tools refuse a call from a worker or from another subagent.

If Claude Code refuses to start a worker, meld stops that worker and shows the reason in its lane. The other workers continue. When no worker starts, the run stops.

**The pane** shows the run in these parts. meld reads the commits and the diff from the version control every 3 seconds.

- **The header** shows the state of the run, the version control and the number of agents. Next to them are the time since the start and the dollars that your session spent since the run started. Where Claude Code keeps no cost record, the header shows the tool calls of all agents. **Stop all** stops the run.
- **The agent lanes** show one lane for each agent, drawn from its real commits since the base, from the oldest to the newest. A diamond is a merge, a star is the final commit, and a red cross is a conflict. A hollow dot shows edits that the agent did not commit. A green check above a commit shows a check that passed on it, and a red cross a check that failed. The terminal draws each lane in characters.
- **Next to each lane**, meld shows the task that the agent claimed, its last action, the time since that action, and the number of its tool calls. If a working agent makes no tool call for 2 minutes, that time turns yellow, and after 5 minutes it turns red. This is the stall warning. **Stop** stops one agent, and its claimed tasks open for the other agents.
- **The task bar** shows the tasks that are done, in progress and open, and the claimed tasks with their owners.
- **The shared context** shows the five newest current entries, one line each: a shape for the kind (■ fact, ✕ fail, ◇ interface), the worker that shared the entry, its text, and the number of workers that read it.
- **The check chips** show the last result of each check command, with its commit. The pane shows six chips at most.
- **The result** shows the final commit, the number of changed files, the lines added and removed, and the checks that ran on that commit. A warning shows when no check ran on it. **Show diff** (key `v`) opens the diff of the first eight files. **Deliver** (key `d`) merges the result into your branch.
- **The preset steers** give every agent a fixed instruction: **+ Tests**, **Smaller**, **Fix checks** and **Integrate now**. Above them, a field takes an instruction in your words. On a ready run, the field asks for changes. The mobile app has no field: send `/meld-steer` and the instruction.
- **The start form** shows in a pane with no run: the task, the number of agents, the model and the version control. **Start** starts the run with these options. On mobile, the pane tells you to send `/meld` and the task.

**Deliver** merges the final commit into your current branch with a merge commit, and removes the workspaces. Your checkout must have no uncommitted changes. If the merge stops, meld aborts it, and nothing changes. **Discard** removes the workspaces with no merge. **Clear** removes a delivered run from the pane.

What you type in the chat goes to Claude, not to the workers. To steer the workers, use the pane or `/meld-steer`, or ask Claude to steer them.

## How it works

1. `/meld` makes one workspace for each worker from `HEAD`, under `/tmp/meld/<run>/`. With jj, each workspace is a jj workspace with the name of its worker. With git, each workspace is a worktree on the branch `meld/<run>/<worker>`.
2. meld starts each worker in its own folder. meld knows each worker by the agent id that Claude Code gives it, not by a name that the model writes.
3. A worker gets its rules at its first board read. The workers plan the task as small tasks on the board, claim them, commit in their own workspaces, share decisions with notes, and share findings in the shared context. A worker takes the commits of another worker with `jj new`, or with `git merge` or `git cherry-pick`.
4. One worker takes the integration: it merges the work of every worker, runs the checks, and declares the final commit. The run is ready for you.
5. If you steer a ready run, the workers change the result, and the run changes to the working state.

The workers use ten board tools: `board`, `add_tasks`, `claim`, `release`, `finish_task`, `note`, `share`, `check`, `integrate` and `finish`. The main session uses three more: `start`, `steer` and `stop`. Each reply of a board tool carries the shared context, the board read of the main session included.

The tools `finish_task`, `check` and `finish` keep the full id of the commit that the revision names in the folder of the worker. `share` does the same when it names a commit. `HEAD` or `@-` names the commit of the worker that calls the tool. meld refuses a final commit with a conflict.

**The shared context.** As in DeLM, the workers keep a shared context of typed entries. A worker adds an entry with `share`: a `kind`, a `text` of 500 characters at most, and an optional `commit`, `files` and `replaces`. A fact is a finding with its evidence. A fail is an approach that did not work, with the reason, so that no worker tries it again. An interface is a contract between tasks: a name and its shape. `replaces` gives the id of an older entry that the new entry corrects. An entry that a newer entry replaces is not current. `finish_task` takes optional `interfaces` and `unfinished` text, and meld adds them to the context as an interface and a fact. Each board reply carries `context`: the current entries, newest first, 20 at most. Each entry has its id, kind, worker, text, commit, files and `seenBy`: the other workers that got the entry in a board reply. The rules tell a worker to share a fact when a peer can use it, a fail when an approach did not work, and an interface before a peer depends on it.

After each change of the board, meld writes the board to `/tmp/meld/<run>/board.json`, with the tasks, the log and the shared context. That file stays when your session ends. Deliver and Discard remove it with the folder of the run.

The task list has a version. A worker adds its tasks in one call, with the version of its last board read. If another worker added tasks since that read, the add fails and shows the current tasks. The worker claims the tasks that cover its work, and adds the tasks that are missing. A claim is a compare-and-set on the task version, so two workers cannot claim one task.

meld refuses an edit that a worker makes outside its own workspace.

**Restarts.** Claude Code ends the run of an agent that meld starts when the agent hands back its work. That agent takes no more messages, and its worker is idle. When a worker ends, Claude Code tells your session. At the end of each turn of your session, meld restarts an idle worker with a new agent in the same folder when there is work for it:

- The board has news that the worker did not read, and there is an open task or a task of that worker. A note, a share, a claim, a finished task or a check of another worker is news.
- Every live worker is idle. In that case, meld restarts the owners of unfinished tasks, and idle workers for the open tasks. With no open task, meld restarts the lead: the integrator, or the first live worker when no worker integrates. The lead plans when there are no tasks, takes your new instruction, or integrates when all tasks are done.

A restarted agent reads its rules at its first board read. Each restart check reads the agent list of Claude Code, so meld finds a worker whose agent ended, though meld did not see the end of its turn. meld does not restart a stopped worker. After three restarts in a row that finish no task, meld stops the restarts and tells you. A finished task or a steer starts the count from zero. A steer goes as a message to each running worker, and the steer restarts the ended workers with it.

**Auto mode.** In auto mode, a classifier decides each Agent call, and it allows a call that it can link to your request. It cannot link a spawn that a plugin makes, so it gives no verdict, and the spawn fails. A mod may approve an action, so meld approves each start and restart of a worker while a run that you started is live. Each action of a worker goes through the mode of your session. A deny from your rules or your organization stands.

**jj.** meld uses jj when jj 0.40 or newer answers in the repository. jj works over a private git store of the run: a bare git repository under `/tmp/meld/<run>/`. The store reads the objects of your repository through git alternates, and it has one ref for the base. The store copies no objects, and the refs of jj do not go into your repository. The jj repository of the run has the git identity of your repository, a base that no worker can rewrite, and no editor. A jj command without `-m` fails and does not wait for an editor. Deliver sets a bookmark on the final commit in the store, fetches that commit into your repository, and merges it. Deliver and Discard remove the folder of the run, and the config that jj keeps for the run in its own config folder.

**git.** meld uses git when jj is not installed, when jj is older than 0.40, or when you give `--vcs git`. With `--vcs auto`, meld uses git when jj cannot make the workspaces, and the start message tells you why. Each worker gets a worktree and a branch. Deliver merges the final commit, and removes the worktrees and the branches.

## What meld changes from DeLM

meld takes its idea from [DeLM](https://github.com/Decentralized-LM/delm-agent-plugin) (Decentralized Language Models, by Yuzhen Mao and Azalia Mirhoseini, MIT license). It is a new tool, not a port, with these changes:

- **TypeScript, with jj or git.** jj workspaces or git worktrees replace the copy-on-write copies, and a git merge replaces the guarded file delivery. meld runs on each system that has git and Claude Code, Linux included.
- **You steer through the pane or `/meld-steer`.** A plain chat message does not become a new task revision ([DeLM issue 18](https://github.com/Decentralized-LM/delm-agent-plugin/issues/18)).
- **A new instruction does not fail a run or block a command.** A worker sees it at its next board call. A stale board call fails alone, and its error tells the worker to read the board ([DeLM issue 17](https://github.com/Decentralized-LM/delm-agent-plugin/issues/17)).
- **The task list has a version.** A stale add fails and shows the current tasks. DeLM's `task_create` has no such check, so two workers that plan at the same moment add the same work twice.
- **A run has five states:** starting, working, ready, delivered and stopped. No recovery state can hold a run.
- **A check is a record:** the command, the commit and the result. meld has no check receipts and no preview ownership.

## Limits

- A run has 1 to 8 workers, and meld runs one run at a time.
- The workers start from your last commit. If the workers need your changes, commit them before the run.
- The workspaces have no installed dependencies. The workers install them when their checks need them.
- A worker of another agent type has the tools of that type. Give a type that has the meld tools and can edit files and run commands, for example `general-purpose`.
- If the `meld:worker` type does not register, meld shows a notice. Give another agent type with `--agents`.
- More workers cost more. The pane shows the dollars that your session spent since the run started, and the tool calls of each agent.
- The edit guard covers Edit, Write, MultiEdit and NotebookEdit. A Bash command can write in other folders, so the guard is a guard rail and not a sandbox.
- The plugin API of Claude Code is an early access API and can change between releases.

## Development

```
claude plugin validate .
claude plugin test .
node scripts/adapters.mjs
```

`hooks/board.ts` holds the board rules as pure functions. `hooks/actions.ts` holds the steps of a run and takes an `Io` port. `hooks/vcs.ts` holds the version control port and its two adapters, jj and git. `hooks/options.ts` reads the options of `/meld`. `hooks/pane.tsx` and `hooks/drawing.ts` draw the pane.

`hooks/register.tsx` is the one file that calls the engine, because a hooks module spells `$` at its call sites and does not give it to other functions. Each hook builds its own `Io`. An agent that a hook spawns runs under that hook and skips it. For this reason, meld has three tool hooks: the start, steer and stop tools, the board tools, and the guard of every other tool. An agent that a timer or a button closure starts skips every hook of meld, the board and the guard included. For this reason, a `ui.press` and a `ui.input` hook serve the buttons and fields that start agents, and the restarts come from hooks of the main session. The guard lets each `SubagentHandback` through, because that call ends the run of a worker.

The tests use a fake `Io` and mount the pane on each surface. A test holds each block of the pane to 100 words at most, with eight agents or with a ready result.

`scripts/adapters.mjs` checks the two adapters with real processes. It compiles `hooks/` with `tsc` into CommonJS in a temporary folder. For each adapter, it makes a temporary git repository and goes through a run: three workspaces, a commit in each, the integration, resolve, lanes, result, deliver and remove. HOME is a temporary folder, so the check does not read or change your git or jj config. It prints PASS or FAIL for each step, and it exits with code 1 when a step fails. It needs `tsc` 5.6 or newer, git, and jj 0.40 or newer.

## License

MIT
