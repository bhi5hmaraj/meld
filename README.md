# meld

Give one request to several Claude Code agents. Watch their real commits in a pane. Get one commit that passed your checks.

Each agent works in its own jj workspace or git worktree. The agents plan the request as tasks on a shared board, share what they learn, and one agent merges the work into a final commit. You steer with one press, and nothing touches your branch until you deliver.

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/working-dark.png">
  <img alt="The meld pane during a run: three agent lanes with their commits, the progress of each task, the shared context, the checks and the steer controls" src="docs/images/working-light.png" width="568">
</picture>
</p>

meld is a Claude Code plugin: one hooks module in TypeScript, with no native binary.

## Install

At the prompt of Claude Code in a terminal:

```
/plugin install meld --marketplace bhi5hmaraj/meld
```

From a shell: `claude plugin install meld --marketplace bhi5hmaraj/meld`.

In the desktop app, click **+** next to the prompt box, and click **Plugins**. Click **Add marketplace**, type `bhi5hmaraj/meld`, and click **Add plugin**.

meld needs git, and it uses jj 0.40 or newer when jj is installed. It was tested with Claude Code 2.1.317, jj 0.46 and git 2.43 on Linux.

## Start a run

Type the request after `/meld`:

```
/meld --agents 3 Add a dark theme with a toggle in the header
```

Or fill in the start form of the pane, which `/meld-status` opens. Or ask Claude in the chat, for example "start a meld run with 3 agents to add a dark theme".

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/start-dark.png">
  <img alt="The start form of the meld pane: the request, the number of agents, the model, the version control and a Start button" src="docs/images/start-light.png" width="568">
</picture>

| Command | What it does |
| --- | --- |
| `/meld <request>` | Starts 2 agents on the request, from the last commit of your repository. |
| `/meld --agents 3 <request>` | Starts 3 agents. A run has 1 to 8 agents. |
| `/meld --agents opus,general-purpose@haiku <request>` | Starts one agent for each item: a model, an agent type, or a type and a model with `@` between them. |
| `/meld --model sonnet <request>` | Starts each agent that names no model on `sonnet`. |
| `/meld --vcs git <request>` | Makes git worktrees. `--vcs jj` makes jj workspaces. `--vcs auto`, the default, uses jj when jj is installed. |
| `/meld /path/to/repo <request>` | Starts the run in another repository. |
| `/meld-steer <instruction>` | Sends a new instruction to every agent. |
| `/meld-status` | Opens the pane. |
| `/meld-stop` | Stops every agent. The workspaces stay for review. |

The options come before the request, in any order. Each agent starts as the hidden agent type `meld:worker`, in its own folder. With no `--model`, an agent uses the model of its agent type, and `meld:worker` uses the model of your session.

## Watch and steer

The picture at the top of this page shows a run at work. meld reads the commits and the diff from version control every 3 seconds.

- **Header** shows the state, the version control, the agents and the time since the start. It shows the dollars that your session spent since the run started. **Stop all** stops the run.
- **Lanes** show the real commits of each agent since the base, oldest first. ◆ is a merge, ★ the final commit, ✕ a conflict, and a dashed ring the edits that the agent did not commit. A green check or a red cross above a commit shows a check that passed or failed on it.
- **Activity** under each lane shows the claimed task, the last action, the time since that action, and the tool calls. The time turns yellow after 2 minutes with no tool call, and red after 5 minutes. **Stop** stops one agent and opens its tasks for the other agents.
- **Progress** shows the percent of the request, and one row for each task. A row shows the percent of the task, a bar of its done, claimed and open parts, and a dot for each agent on it. `waits for #N` shows while a task that it needs is not done. A press on a row with parts opens the parts.
- **Shared context** shows the five newest entries that the agents shared: ■ a fact, ✕ a fail, ◇ an interface. Each entry shows the number of agents that read it.
- **Checks** show the last result of each check command, with its commit.
- **Steer** takes an instruction in your words, and four presets: **+ Tests**, **Smaller**, **Fix checks** and **Integrate now**.

What you type in the chat goes to Claude, not to the agents. To steer the agents, use the pane or `/meld-steer`, or ask Claude to steer them. The mobile app has no text field, so send `/meld-steer` and the instruction. The terminal draws the lanes and the bars in characters.

## Deliver the result

When one agent has merged the work of all agents and run the checks, it declares the final commit, and the run is ready.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/ready-dark.png">
  <img alt="A run that is ready to deliver: all tasks at 100 percent, three checks passed on the final commit, and the Deliver button" src="docs/images/ready-light.png" width="568">
</picture>

The result card shows the final commit, the changed files, the lines added and removed, and the checks that ran on that commit. A warning shows when no check ran on it.

- **Deliver** (`d`) merges the final commit into your branch with a merge commit, and removes the workspaces. Your checkout must have no uncommitted changes. If the merge stops, meld aborts it, and nothing changes.
- **Show diff** (`v`) opens the diff of the first eight files.
- **Ask for changes** gives the agents your instruction, and they change the result.
- **Discard** removes the workspaces with no merge. **Clear** removes a delivered run from the pane.

## How it works

1. **Workspaces.** meld makes one workspace for each agent from `HEAD`, under `/tmp/meld/<run>/`: a jj workspace, or a git worktree on a branch such as `meld/<run>/w1`.
2. **Plan.** The agents plan the request as small tasks on the board. When two agents plan at the same time, the first plan wins, and the other agent claims tasks from it. A task can name a parent, a size (S, M or L) and the tasks that it needs.
3. **Work.** Each agent claims a task, commits in its own workspace, and takes the commits of other agents with `jj new`, `git merge` or `git cherry-pick`. An agent splits a large task with `split`: it keeps the first part, and the other parts open for the other agents. After `finish_task`, the agent hands back, and meld starts a new agent for the next task.
4. **Share.** The agents share facts, fails and interfaces. Each board reply carries the entries that are new for the agent, and the rules tell an agent not to try an approach that failed.
5. **Integrate.** One agent merges the work of every agent, runs the checks, and declares the final commit.

The agents use eleven board tools: `board`, `add_tasks`, `claim`, `split`, `release`, `finish_task`, `note`, `share`, `check`, `integrate` and `finish`. The main session has three more: `start`, `steer` and `stop`. These three refuse a call from an agent or another subagent.

<details>
<summary><b>The board</b>: versions, the task tree, the percent, the shared context</summary>

**Versions.** The task list has a version. An agent adds its tasks in one call, with the version of its last board read. If another agent added tasks since that read, the add fails and shows the current tasks. A claim is a compare-and-set on the task version, so two agents cannot claim one task.

As `add_tasks` does, `split` takes the version of the task list. A part names its needs by number, so a split after a stale read can make a part need the wrong task. A stale split fails with `STALE_VERSION` and shows the current tasks.

**Task tree.** The parents make the tasks a tree, and the needs make a DAG. A task with no size is M. While a need of a task, or a need of one of its parents, is not done, a claim of the task fails with `WAITING`, and the error names the need. `add_tasks` and `split` refuse a need that makes a loop. A parent has no commit of its own. It is done when all its parts are done, and `claim` and `finish_task` refuse it. The first part of a split cannot wait, because the agent keeps it.

**Times.** Each task keeps the time when it was added, when it became ready, when it was claimed and when it was done. It counts the times that it returned to open: a release, or a stop of its agent.

**Percent.** meld computes the percent from the task states, and no agent reports a percent. A task is at 0 until an agent finishes it, and at 100 after that. A parent is the mean of its parts, with the sizes S 1, M 3 and L 8 as weights. Each percent is cut to the whole number below it, so 100% means that all the work is done.

**Nudge.** After a number of tool calls on one task with no finish and no split, meld tells the agent one time: "Split #N into smaller tasks, or finish it." The number goes by the size of the task: 30 for S, 60 for M and 120 for L. A task with no size is M. One limit of 40 for each task fired on 11 of the 22 tasks of a run, so the nudge did not show which tasks were too large.

**Shared context.** As in DeLM, the agents keep a shared context of typed entries. `share` takes a `kind`, a `text` of 500 characters at most, and an optional `commit`, `files` and `replaces`. A fact is a finding with its evidence. A fail is an approach that did not work, with the reason. An interface is a contract between tasks: a name and its shape. An entry with `replaces` corrects an older entry. `finish_task` takes optional `interfaces` and `unfinished` text, which meld adds as an interface and a fact. The task keeps the two texts as its handover.

The first board reply to a new agent carries the 20 newest current entries. Each later reply carries only the current entries that are new since the last reply to that agent, and not the entries of the agent. Each entry shows `seenBy`: the agents that got it. A reply that carries the same 20 entries each time makes every turn longer: in a run of 22 tasks and 5 agents, each turn read about 280,000 tokens again.

**Commits.** `finish_task`, `check`, `finish` and `share` keep the full id of the commit that the revision names in the folder of the agent. `HEAD` or `@-` names the commit of the agent that calls the tool. meld refuses a final commit with a conflict.

**Board file.** After each change, meld writes the board to `/tmp/meld/<run>/board.json`: the tasks, the log and the shared context. The file stays when your session ends. Deliver and Discard remove it.

**Edit guard.** meld refuses an edit that an agent makes outside its own workspace.

</details>

<details>
<summary><b>Restarts, auto mode, jj and git</b></summary>

**Restarts.** Claude Code ends an agent when the agent returns its result. At the end of each turn of your session, meld restarts an idle agent in the same folder when there is work for it:

- A task is ready, and the agent claims no task. meld restarts one agent for each ready task at most.
- The board has news that the agent did not read, and the agent claims a task that is not done. A note, a share, a claim, a finished task or a check of another agent is news.
- Every live agent is idle. meld restarts the owners of unfinished tasks, and idle agents for the open tasks. With no open task, meld restarts the lead, the integrator or the first live agent, to plan, to take your new instruction, or to integrate.

**A new agent for each task.** After `finish_task`, the rules and the reply of `finish_task` tell the agent to hand back, and not to claim the next task. meld restarts the agent when a task is ready. An agent that does task after task reads its whole history again on each turn, and that history grows with each task. A new agent starts from the board: the request, the steers, the tasks and the shared context. The reply of its claim gives the handovers of the tasks that its task needs: the commit, the interfaces and the unfinished work of each. A board read gives the same handovers for the tasks that the agent claims. The task list in a board reply does not carry the handovers.

A restarted agent reads its rules at its first board read. meld reads the agent list of Claude Code, so it finds an agent that ended when meld did not see the end. meld does not restart a stopped agent. After three restarts in a row that finish no task, meld stops the restarts and tells you. A finished task or a steer starts the count from zero. A steer goes as a message to each running agent, and it restarts the agents that ended.

**Refused starts.** If Claude Code refuses to start an agent, meld stops that agent and shows the reason in its lane. The other agents continue. When no agent starts, the run stops.

**Auto mode.** In auto mode, a classifier decides each Agent call, and it allows a call that it can link to your request. It cannot link a start that a plugin makes, so that start fails. A plugin may approve an action, so meld approves each start and restart of an agent while a run that you started is live. Each action of an agent goes through the mode of your session, and a deny from your rules or your organization stands.

**jj.** meld uses jj when jj 0.40 or newer answers in the repository. jj works over a private git store of the run: a bare git repository under `/tmp/meld/<run>/`. The store reads the objects of your repository through git alternates and has one ref for the base. It copies no objects, and the refs of jj do not go into your repository. The jj repository of the run has the git identity of your repository, a base that no agent can rewrite, and no editor: a jj command without `-m` fails and does not wait. Deliver sets a bookmark on the final commit in the store, fetches that commit into your repository, and merges it. Deliver and Discard remove the folder of the run and the jj config of the run.

**git.** meld uses git when jj is not installed, when jj is older than 0.40, or when you give `--vcs git`. With `--vcs auto`, meld uses git when jj cannot make the workspaces, and the start message tells you why. Each agent gets a worktree and a branch. Deliver merges the final commit and removes the worktrees and the branches.

</details>

## What meld changes from DeLM

meld takes its idea from [DeLM](https://github.com/Decentralized-LM/delm-agent-plugin) (Decentralized Language Models, by Yuzhen Mao and Azalia Mirhoseini, MIT license). It is a new tool, not a port.

<details>
<summary><b>Six changes</b></summary>

- **jj or git, in TypeScript.** Workspaces replace the copy-on-write copies, and a git merge replaces the guarded file delivery. meld runs on each system that has git and Claude Code, Linux included.
- **Steer in the pane.** A plain chat message does not become a new task revision ([DeLM issue 18](https://github.com/Decentralized-LM/delm-agent-plugin/issues/18)).
- **A new instruction blocks nothing.** An agent sees it at its next board call. A stale board call fails alone, and its error tells the agent to read the board ([DeLM issue 17](https://github.com/Decentralized-LM/delm-agent-plugin/issues/17)).
- **A task list with a version.** A stale add fails and shows the current tasks. DeLM's `task_create` has no such check, so two agents that plan at the same moment add the same work twice.
- **Five run states:** starting, working, ready, delivered and stopped. No recovery state can hold a run.
- **A check is a record:** the command, the commit and the result. meld has no check receipts and no preview ownership.

</details>

## Limits

- A run has 1 to 8 agents, and meld runs one run at a time.
- The agents start from your last commit. Commit your changes before the run if the agents need them.
- The workspaces have no installed dependencies. The agents install them when their checks need them.
- An agent of another type has the tools of that type. Give a type that has the meld tools and can edit files and run commands, for example `general-purpose`.
- If the `meld:worker` type does not register, meld shows a notice. Give another agent type with `--agents`.
- More agents cost more. The header shows the dollars since the run started, and each lane shows the tool calls of its agent.
- The edit guard covers Edit, Write, MultiEdit and NotebookEdit. A Bash command can write in other folders, so the guard is a guard rail, not a sandbox.
- The plugin API of Claude Code is an early access API, and it can change between releases.

## Development

```
claude plugin validate .
claude plugin test .
node scripts/adapters.mjs
node scripts/shots.mjs
```

- `hooks/board.ts` holds the board rules as pure functions, `hooks/tasks.ts` the task tree, and `hooks/progress.ts` the percent.
- `hooks/actions.ts` holds the steps of a run, and takes an `Io` port.
- `hooks/vcs.ts` holds the version control port and its two adapters, jj and git.
- `hooks/options.ts` reads the options of `/meld`.
- `hooks/pane.tsx` and `hooks/drawing.ts` draw the pane.
- `hooks/register.tsx` is the one file that calls the engine.

<details>
<summary><b>The hooks, the tests and the two scripts</b></summary>

A hooks module spells `$` at its call sites and does not give it to other functions, so each hook builds its own `Io`. An agent that a hook starts runs under that hook and skips it. For this reason, meld has three tool hooks: the start, steer and stop tools, the board tools, and the guard of every other tool. An agent that a timer or a button closure starts skips every hook of meld. For this reason, a `ui.press` and a `ui.input` hook serve the buttons and fields that start agents, and the restarts come from hooks of the main session. The guard lets each `SubagentHandback` through, because that call ends the run of an agent.

The tests use a fake `Io` and mount the pane on each surface. A test holds each block of the pane to 100 words at most.

`scripts/adapters.mjs` checks the jj and git adapters with real processes. It compiles `hooks/` with `tsc` into a temporary folder. For each adapter, a temporary git repository goes through a run: three workspaces, a commit in each, the integration, the result, deliver and remove. HOME is a temporary folder, so the check does not read or change your git or jj config. The script prints PASS or FAIL for each step, and it exits with code 1 when a step fails. It needs `tsc` 5.6 or newer, git, and jj 0.40 or newer.

`scripts/shots.mjs` draws the pictures of this README. `scripts/scenes.tsx` builds sample runs with the board functions and prints the tree that the pane draws for each run. The script makes an HTML page of each tree, and takes a picture in a light and a dark theme with Playwright. The lanes, the bars and the texts are the ones that meld draws. The fonts and the spacing stand in for the app.

</details>

## License

MIT
