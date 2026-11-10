# How meld works

This page gives the details that the [README](../README.md) leaves out. Two words have a fixed sense here. A worker is a place of the run on the board (w1, w2), with its folder. An agent is the process that works in that place, and a worker can get a new agent.

## Agents

Each agent starts as the hidden agent type `meld:worker`, in its own folder. With no `--model`, an agent uses the model of its agent type, and `meld:worker` uses the model of your session.

- **Claude agents** run as subagents of your session.
- **Codex** runs through ACP with `npx -y @agentclientprotocol/codex-acp`, which needs Node and an OpenAI login. `meld mcp` runs it, so it needs Bun.
- **Gemini and Cursor** run through ACP with `npx -y @google/gemini-cli --acp` and `agent acp`. Each needs its own login. Neither has a live check yet.
- **Your own ACP agent** runs with `--agents acp:<name>`. Set `MELD_ACP_AGENTS` in the environment of Claude Code to a JSON object from a name to its command, for example `{"mine":["node","/path/to/agent.js"]}`. A name of the table, such as `codex`, gets the command that you give.

An agent of another type has the tools of that type. Give a type that has the meld tools and can edit files and run commands, for example `general-purpose`. If the `meld:worker` type does not register, meld shows a notice. Then give another agent type with `--agents`.

## The pane

meld reads the commits and the diff from version control every 3 seconds.

- **Header:** the state, the version control, the agents, the time since the start, and the dollars that your session spent since the run started. **Stop all** stops the run.
- **Lanes:** the real commits of each agent since the base, oldest first. A diamond is a merge, a star the final commit, a cross a conflict, and a dashed ring the edits that the agent did not commit. A green check or a red cross above a commit shows a check that passed or failed on it.
- **Activity:** under each lane, the claimed task, the last action, the time since that action, and the tool calls. The time turns yellow after 2 minutes with no tool call, and red after 5 minutes. **Stop** stops one agent and opens its tasks for the other agents.
- **Progress:** the percent of the request, and one row for each task. A row shows the percent of the task, a bar of its done, claimed and open parts, and a dot for each agent on it. `waits for #N` shows while a task that it needs is not done. A press on a row with parts opens the parts.
- **Shared context:** the five newest entries that the agents shared, and the number of agents that read each. A square is a fact, a cross a fail, and a hollow diamond an interface.
- **Checks:** the last result of each check command, with its commit.
- **Steer:** an instruction in your words, and four presets: **+ Tests**, **Smaller**, **Fix checks** and **Integrate now**.

What you type in the chat goes to Claude, not to the agents. To steer the agents, use the pane or `/meld-steer`, or ask Claude to steer them. The mobile app has no text field, so send `/meld-steer` and the instruction. The terminal draws the lanes and the bars in characters.

## Control a run without the pane

Some places show no meld pane, for example a cloud session in the Claude app. Each action of the pane has a command, and Claude has a tool for each one.

| Command | Tool | Effect |
|---|---|---|
| `/meld-steer <instruction>` | `steer` | Gives every agent the instruction. |
| `/meld-stop` | `stop` | Stops every agent. The workspaces stay. |
| `/meld-deliver` | `deliver` | Merges the final commit into your branch, and removes the workspaces. |
| `/meld-discard` | `discard` | Stops the run, and removes its workspaces with their commits. |
| `/meld-add [agent]` | `add_worker` | Adds an agent to a run at work. |

Only the main session uses these tools. An agent of the run that calls one gets `NOT_ALLOWED`.

`/meld-add` adds one worker to a run that starts or works, up to 8 workers. Its workspace starts from the head of the integration line, so it has the finished work. With no finished task, it starts from the base. Its agent starts at once and reads the board.

Name the model or type as `/meld --agents` does: `opus`, `Explore`, or `general-purpose@haiku`. With no name, the new worker takes the agent of w1. When the run gets its final commit while the agent starts, meld does not bind the agent to the new worker. The worker then shows as not started, so the run does not wait for it.

## Deliver, archives and old runs

Deliver merges the final commit into your branch with a merge commit, and removes the workspaces. Your checkout must have no uncommitted changes. If the merge stops, meld aborts it, and nothing changes.

Deliver refuses a final commit that lacks the commit of a task that is done on the board. The reply names the tasks, and you steer the run so that an agent merges them. The subject of the merge commit is `meld: ` and the summary of the final commit, cut at a space to 72 characters at most. With no summary, it is the first line of the request. The body holds the full request.

Ask for changes gives the agents your instruction, and they change the result. meld first moves the integration line to the final commit, so that the next final commit keeps its work. Show diff opens the diff of the first eight files. Clear removes a delivered run from the pane.

### Archive

Before Deliver, Discard or a new start removes the folder of a run, meld writes the record of the run to `~/.meld/archive/<run>.json`, with mode 600. The record holds the run, the board (the request, the steers and the tasks), the events and the context entries. With `MELD_DB`, `meld mcp` writes it to the folder `archive` next to the board file. When meld cannot write the record, Deliver merges nothing and Discard removes nothing. The run and its workspaces stay, and the reply tells why.

### Old runs

A stopped run keeps its workspaces until you deliver or discard it. A new start removes them when they hold no work, as after a start that started no agent. When they hold commits or uncommitted edits, or meld cannot read them, the start refuses. The reply names the run, its folder and its count of commits.

New files count as edits, also when `status.showUntrackedFiles=no` hides them from `git status`. jj does not record a new file over `snapshot.max-new-file-size` (1 MiB). So meld cannot read a jj workspace that holds one, and the reply names the file.

### /meld-clean

`/meld-clean` lists the folders under `/tmp/meld/` that are not the run of your session. It reads the record of the run of each folder in `~/.meld/meld.db`: its state, version control, repository, base and workers, and the time of its last change. Without Bun, and for a run that an older meld started, a folder has no record.

When a folder is not maybe live and meld can read its record, meld reads its workspaces as a new start does. The line of the folder then ends with `no work`, with `holds work: 2 commits` and the agents that have uncommitted edits, or with `workspaces not readable`.

`/meld-clean <id>` removes a folder as Discard does, with the version control and the repository that its record names, and with any work in it. meld takes the workspaces from the id of the folder and the worker ids, and the base from the record. So a read or a removal touches only what meld made. With no record that meld can read, meld removes only the folder. `/meld-clean` never removes the run of your session: Discard or `/meld-discard` removes it.

`--all` removes a folder only when meld can read its record, the folder is not maybe live, and its workspaces hold no work. It keeps each other folder, and the reply tells why. The folder holds work, meld cannot read its workspaces, the folder has no record, or meld cannot read its record. A record with no workers counts as not readable, and so does a record with an entry that is not a worker of meld. The work check would miss workspaces of such a folder. To remove a kept folder, give its id.

A folder is maybe live when its record changed in the last 24 hours, and says starting, working or ready, or cannot be read. A run of another session on this computer can use such a folder. So meld does not read its workspaces, `--all` skips it, and its id removes it. The state alone shows nothing: a run that no session stores keeps the last state that it wrote.

## MCP clients

A chat that speaks MCP, such as a chat of Cursor, can lead a run. `meld mcp --chat` gives it the tools of the main session: `start`, `board`, `steer`, `stop`, `deliver`, `discard` and `add_worker`. All its agents are ACP agents: `codex`, `gemini`, `cursor`, or a name of `MELD_ACP_AGENTS`.

meld works in the folder where the chat starts the server. To work in another repository, begin the request with its path. A start with no agents, or with a count, takes the agent of `MELD_CHAT_AGENT`, or `codex` when it is not set. The board of the chat is `MELD_BOARD`, or `chat:<folder>`. The board reply gives the notices that Claude Code shows as toasts. This mode is new in 0.10, and a live check with Cursor is still to come.

## The board

The agents use eleven board tools: `board`, `add_tasks`, `claim`, `split`, `release`, `finish_task`, `note`, `share`, `check`, `integrate` and `finish`. The main session has three more: `start`, `steer` and `stop`. These three refuse a call from an agent or another subagent.

With `view: "status"`, `board` gives the main session a short board, and with no view the full board. The short board has the run state, the task counts and the log entries since the last status read. A task row has the id, title, state, owner, and the needs that are not done. A worker row has the id, state, claims, and the seconds since the last call.

### Versions

The task list has a version. An agent adds its tasks in one call, with the version of its last board read. If another agent added tasks since that read, the add fails and shows the current tasks. A claim is a compare-and-set on the task version, so two agents cannot claim one task.

As `add_tasks` does, `split` takes the version of the task list. A part names its needs by number, so a split after a stale read can make a part need the wrong task. A stale split fails with `STALE_VERSION` and shows the current tasks.

### Task tree

The parents make the tasks a tree, and the needs make a DAG. A task with no size is M. A claim of a task fails with `WAITING` while a need of the task, or of one of its parents, is not done. The error names the need. `add_tasks` and `split` refuse a need that makes a loop.

An agent splits a large task with `split`: it keeps the first part, and the other parts are open for the other agents. A parent has no commit of its own. It is done when all its parts are done, and `claim` and `finish_task` refuse it. The first part of a split cannot wait, because the agent keeps it.

Each task keeps the time when it was added, when it became ready, when it was claimed and when it was done. It counts the times that it returned to open: a release, or a stop of its agent.

### Percent

meld computes the percent from the task states, and no agent reports a percent. A task is at 0 until an agent finishes it, and at 100 after that. A parent is the mean of its parts, with the sizes S 1, M 3 and L 8 as weights. Each percent is cut to the whole number below it, so 100% means that all the work is done.

### Nudge

After a number of tool calls on one task with no finish and no split, meld tells the agent one time: "Split #N into smaller tasks, or finish it." The number goes by the size of the task: 30 for S, 60 for M and 120 for L. An earlier limit of 40 for each task fired on 11 of the 22 tasks of a run. So it did not show which tasks were too large.

### Shared context

As in DeLM, the agents keep a shared context of typed entries. `share` takes a `kind`, a `text` of 500 characters at most, and an optional `commit`, `files` and `replaces`. An entry with `replaces` corrects an older entry.

- **A fact** is a finding with its evidence.
- **A fail** is an approach that did not work, with the reason.
- **An interface** is a contract between tasks: a name and its shape.

`finish_task` takes optional `interfaces` and `unfinished` text, which meld adds as an interface and a fact. The task keeps the two texts as its handover.

The first board reply to a new agent carries the 20 newest current entries. Each later reply carries only the current entries that are new since the last reply to that agent, and not the entries of the agent. Each entry shows `seenBy`: the agents that got it. A reply that carries the same 20 entries each time makes every turn longer: in a run of 22 tasks and 5 agents, each turn read about 280,000 tokens again.

### Commits

`finish_task`, `check`, `finish` and `share` keep the full id of the commit that the revision names in the folder of the agent. `HEAD` or `@-` names the commit of the agent that calls the tool. meld refuses a final commit with a conflict. `finish` also refuses a final commit that lacks the commit of a done task, with `MISSING_WORK`. `git merge-base --is-ancestor` reads each commit, and the error names the tasks, their commits and the steps that merge them.

### Board file

With Bun, the run lives on a board in `~/.meld/meld.db`, in WAL mode, and each session has its own board. Without Bun, the session state keeps the run, and the run ends with the session. Without `meld mcp`, a start says that its run has no board file.

The plugin reads the board, runs the rules of meld, and commits the run at the version that it read, through the tools of `meld mcp`. When another write came first, it reads and tries again. A write that changes nothing stores nothing. The session state keeps a copy of the run, and the facts that the pane shows.

The session that writes a board owns it for 60 s from its last write. Another session can adopt the board only after that time, so two sessions do not drive one run. The file also keeps each log entry and context entry of each run as a row, after the run trims them. It keeps a record of each run for `/meld-clean`, also after the run leaves its board.

Only meld calls the tools of `meld mcp`. The permission check allows the calls of meld, and refuses the calls of agents and of the main session. The board tool of the main session names the store, and why `meld mcp` did not connect. When the session started before meld was installed or updated, a new session starts `meld mcp`. In a local session, `/reload-plugins` starts it too.

Deliver marks the run delivered, and Discard drops it, before they remove its folder. So no restart gives a new agent to a run whose folder goes.

### Backups

Once a day, at the start of a session, `meld mcp` copies the board file to `~/.meld/backups/meld-<date>.db`, and keeps the five newest copies. Then it removes the rows older than 30 days that no run needs. To restore a copy, close each session that runs meld, remove `~/.meld/meld.db-wal` and `~/.meld/meld.db-shm`, and copy the backup to `~/.meld/meld.db`.

## Guards

### Edit guard

meld refuses an edit that an agent makes outside its own workspace. It also refuses each tool call of these agents, and tells them to end their turn:

- an agent that you stopped
- an agent of a stopped or discarded run
- a new agent that took no place on the board

The edit guard covers Edit, Write, MultiEdit and NotebookEdit. A Bash command can write in other folders, so the guard is a guard rail, not a sandbox. The rules tell each agent to write only in its own folder.

### Version control in the folder of an agent

The shell of an agent starts in the folder of the session, not in its own folder. So an agent runs `git -C <its folder>` or `jj -R <its folder>`, and Claude Code asks a person for that form. meld allows that form in the agent's own folder, for the commands of the rules and with no shell syntax. So a run with no person can commit.

For git, the commands are status, diff, log, show, add, commit, rev-parse, ls-files, merge and cherry-pick. For jj, they are status, st, log, diff, show, commit, new and workspace update-stale. Options that run a program, such as `--config` and `--tool` of jj, keep the ask. A deny rule still stands, and so does an ask for any other command.

### Permission checks

meld has three `tool.check` hooks. Claude Code runs the `tool.check` hooks of all plugins in a chain. A hook can give a verdict and not call the next hook. When a hook of another plugin does this, the check of meld does not run:

- **The board check** allows the calls of meld to `meld mcp`, and refuses the calls of agents, of the main session and of other plugins. Without it, the other plugin or the mode of your session decides each call. A call of meld can wait for your answer or fail, and a call of an agent is not refused.
- **The Agent check** approves each start and restart of an agent in auto mode, while a run that you started is live. Without it, auto mode refuses these starts, and meld shows the reason in the lane of the agent.
- **The version control check** allows `git -C` and `jj -R` in the own folder of an agent, for the commands of the rules. Without it, Claude Code asks you for each such call, and a run with no person cannot commit.

The edit guard is a `tool.call` hook, and a skip in `tool.check` does not stop it.

## Restarts and compaction

### Restarts

Claude Code ends an agent when the agent returns its result. At the end of each turn of your session, meld restarts an idle agent in the same folder when there is work for it:

- **A task is ready, and the agent claims no task.** meld restarts one agent for each ready task at most. An agent that works, claims no task and does not integrate counts for one of them: meld started it for a task, or it planned the tasks, and it claims a task next. The integrator does not count, as it takes no task, and an agent that Claude Code did not start yet does not count.
- **The board has news that the agent did not read, and the agent claims a task that is not done.** A note, a share, a claim, a finished task or a check of another agent is news.
- **Every live agent is idle.** meld restarts the owners of unfinished tasks, and idle agents for the open tasks. With no open task, meld restarts the lead, the integrator or the first live agent, to plan, to take your new instruction, or to integrate.

A restarted agent reads its rules at its first board read. meld reads the agent list of Claude Code, so it finds an agent that ended when meld did not see the end. meld does not restart a stopped agent. After three restarts in a row that finish no task, meld stops the restarts and tells you. A finished task or a steer starts the count from zero. A steer goes as a message to each running agent, and it restarts the agents that ended.

A restart waits for the end of a turn of your session. In a session with no person, nothing starts that turn, so idle agents wait ([#12](https://github.com/bhi5hmaraj/meld/issues/12)).

### A short session, then a new agent

After `finish_task`, the rules and the reply of `finish_task` tell the agent to hand back, and not to claim the next task. When there is work for an idle worker, meld gives the next step to the same agent, in its own session. It does so while the context of that agent fills less than half of the window of its model, and less than 150k tokens. So the agent keeps the code that it read. Else meld starts a new agent: an agent that does task after task reads its whole history again on each turn.

An agent of the type `meld:worker` compacts its conversation before 150k tokens and goes on. Claude Code keeps room below that window, so the compaction comes near 120k tokens. The summary keeps its tasks, its commits and what is left. Its next board read gives its rules again.

meld reads the context of a Claude agent from its last model call. An ACP agent, such as Codex, reports its context with `usage_update`. An ACP agent that reports none gets a new agent each time.

A new agent starts from the board: the request, the steers, the tasks and the shared context. The reply of its claim gives the handovers of the tasks that its task needs: the commit, the interfaces and the unfinished work of each. A board read gives the same handovers for the tasks that the agent claims. The task list in a board reply does not carry the handovers.

### One line for each turn

The rules, the system prompt of `meld:worker` and the end of the spawn prompt tell an agent to end each turn with one line. An example is `finished #4, commit 4a0bde04`. Claude Code gives the last message of each turn of an agent to your session, and a plugin cannot change it. With a new agent for each task, a run of 22 tasks gives 22 such messages.

After each hand-back, Claude Code also sends a task notification to your session. meld cannot join these notifications or change them. The board keeps the detail.

### Refused starts and auto mode

If Claude Code refuses to start an agent, meld stops that agent and shows the reason in its lane. The other agents continue. When no agent starts, the run stops.

In auto mode, a classifier decides each Agent call, and it allows a call that it can link to your request. It cannot link a start that a plugin makes, so that start fails. A plugin may approve an action, so meld approves each start and restart of an agent while a run that you started is live. Each action of an agent goes through the mode of your session, and a deny from your rules or your organization stands.

## jj and git

### jj

meld uses jj when jj 0.40 or newer answers in the repository. jj works over a private git store of the run: a bare git repository under `/tmp/meld/<run>/`. The store reads the objects of your repository through git alternates and has one ref for the base. It copies no objects, and the refs of jj do not go into your repository.

The jj repository of the run has the git identity of your repository, a base that no agent can rewrite, and no editor: a jj command without `-m` fails and does not wait. Deliver sets a bookmark on the final commit in the store, fetches that commit into your repository, and merges it. Deliver and Discard remove the folder of the run and the jj config of the run. The first line of that config names the run, and meld removes a jj config only when that line names the run.

### git

meld uses git when jj is not installed, when jj is older than 0.40, or when you give `--vcs git`. With `--vcs auto`, meld uses git when jj cannot make the workspaces, and the start message tells you why. Each agent gets a worktree and a branch, such as `meld/<run>/w1`. Deliver merges the final commit and removes the worktrees and the branches. A removal removes the run folder first, then prunes the worktrees and drops the branches. So it gives git no folder that an agent can make a link.

## The integration line

### Why

In meld 0.7.0, one agent merged the work of every agent at the end. In a run of 22 tasks, that integration was slow, it came last, and a conflict showed long after the change that made it. Now each task goes into the line when it finishes. A conflict shows while its change is new and small, and the end needs one build.

### The line

The line starts at the base. With git, it is the branch `meld/<run>/integration` of your repository. With jj, it is a ref of the private store of the run, which jj imports as the bookmark `meld_integration`, so each workspace sees it. Deliver and Discard remove it with the run. The rules tell the agents not to move or rewrite it.

### A steer from ready

Before a steer of a ready run, meld moves the line to the final commit, which holds the done tasks. With git, `git update-ref` moves the branch. With jj, meld moves the ref in the store and runs `jj git import`. The merges after the steer and the next final commit then keep the work of that commit.

When the line cannot move, the steer changes nothing, and the run stays ready. The board takes a steer of a ready run only when the line is at its final commit. The lead can declare the final commit after meld read a working run for the steer. Then the board refuses the steer, and meld moves the line and tries again.

### The merge

After each `finish_task`, and before its reply, meld merges the commit of that task into the line. When the commit holds the line, the line moves forward to the commit. Else git makes the merge with no working copy: `git merge-tree --write-tree` makes the tree, `git commit-tree` makes the merge commit, and `git update-ref` moves the line only from the head that the merge read. No agent and no workspace take part, and one merge runs at a time. meld does not merge a commit with a jj conflict, because its tree holds the sides of the conflict.

### integrate #N

When a merge conflicts or fails, the line stays where it was, and meld adds the task `integrate #N` of size S. Its detail names the files in conflict and the steps: `jj new meld_integration <commit>`, or `git merge meld/<run>/integration` and then `git merge <commit>`, a fix, the checks, a commit and `finish_task`. meld merges that commit as it merges any other, and then the line holds #N.

### The end

When every task is done, meld asks the lead to start from the line and merge the commits that the line does not hold. The lead then runs one final build and the checks, and calls `finish`. A task can finish after the lead started from the line. So `finish` and Deliver refuse a final commit that lacks the commit of a done task.

### The proposal and the code

The proposal was a merge through the vcs adapters, with no agent. meld does that with git plumbing for both adapters, because jj keeps its commits in a git store. So one merge serves jj and git, and no merge needs a working copy, as `jj new` in a workspace does.

A finish merges the commit of its own task alone. So its reply waits for one merge, and for the merges of the finishes before it. The lead merges the done tasks that the line does not hold at the end: a task whose merge a restart of your session skipped, and the finished tasks of a run that meld 0.7.0 stored. `finish` refuses a final commit that lacks one of them.

### Peers

The rules tell an agent to take the commits of another agent, with `jj new`, `git merge` or `git cherry-pick`, only when its own task needs that code. The line gathers the finished tasks, so a merge to stay current only adds conflicts and context.

## What meld changes from DeLM

meld takes its idea from [DeLM](https://github.com/Decentralized-LM/delm-agent-plugin) (Decentralized Language Models, by Yuzhen Mao and Azalia Mirhoseini, MIT license). It is a new tool, not a port.

- **jj or git, in TypeScript.** Workspaces replace the copy-on-write copies, and a git merge replaces the guarded file delivery. meld runs on each system that has git and Claude Code, Linux included.
- **Steer in the pane.** A plain chat message does not become a new task revision ([DeLM issue 18](https://github.com/Decentralized-LM/delm-agent-plugin/issues/18)).
- **A new instruction blocks nothing.** An agent sees it at its next board call. A stale board call fails alone, and its error tells the agent to read the board ([DeLM issue 17](https://github.com/Decentralized-LM/delm-agent-plugin/issues/17)).
- **A task list with a version.** A stale add fails and shows the current tasks. DeLM's `task_create` has no such check, so two agents that plan at the same moment add the same work twice.
- **Five run states:** starting, working, ready, delivered and stopped. No recovery state can hold a run.
- **A check is a record:** the command, the commit and the result. meld has no check receipts and no preview ownership.
