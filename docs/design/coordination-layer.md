# meld as a coordination layer

Status: draft. Nothing here is built. This note changes phase 4 of [plan.md](plan.md).

## 1. The decision

meld does one job: it coordinates several agents on one request. It owns the task queue, the shared context during a run, the integration line and the evidence of each run. For all other jobs, meld uses the tools that people already use. It does not build them again, and it does not wait for them to add what meld needs.

meld works with any agent that speaks MCP or ACP. It runs on any machine with git, Bun and the agent CLIs. When the results of meld are clear, the people who build those tools can take the ideas upstream.

## 2. What meld owns

| Part | What it does | Where it is today |
|---|---|---|
| Task queue | Workers add tasks, claim them (the first claim wins), split them, and hand over to the tasks that need them. | Built in `core/` |
| Shared context | Facts, fails and interfaces. Each board reply carries the entries that the worker has not seen. No agent is woken. | Built in `core/` |
| Integration line | Each finished task merges into one line with git plumbing. A conflict becomes a task "integrate #N". | Built in `core/vcs.ts` |
| Evidence | The run log, the archive of each run, and the system metrics of [pane-metrics-logs.md](pane-metrics-logs.md) | A first archive file in 0.10.1. The rest is designed |

## 3. What meld uses from other tools

| Job | Tools | How meld uses them |
|---|---|---|
| Watch and steer sessions | Codecast, Amp | meld builds no inbox and no web page. A Codecast daemon on the host shows each worker session in its inbox. |
| History across runs | Codecast session search, Amp thread search | meld keeps the shared context of each run in its archive. Search across runs comes from these tools first. |
| Agents | Claude Code, Codex, Gemini CLI, Cursor, and any agent that speaks MCP or ACP | A worker is any agent that can call the board tools. |
| Sandboxes | A cloud VM now. Later: E2B, Amp orbs, the sandboxes of a team | Any machine with a checkout, git 2.38 or newer, Bun and the agent CLIs |

### 3.1 How the tools differ

The table compares the parts that matter to meld. It shows the tools on 10 November 2026.

| | Codecast | Amp | meld |
|---|---|---|---|
| Kind | Open-source team workspace over several agent CLIs | Hosted agent product, not open source | Open-source coordination layer |
| How agents start | A daemon starts each CLI in a tmux pane and types into it | Its own agent, local or in a cloud machine for each thread (an orb) | Claude Code subagents, and ACP processes |
| Isolation of each agent | Plan runs share one checkout. `cast spawn --isolated` gives a git worktree. | One cloud machine for each thread | One jj workspace or git worktree for each worker |
| Task queue | Tasks with dependencies, waves and claims. A loop starts one agent for each ready task. | None. An assistant (Puck) splits a request and collects reports. | Workers claim tasks and split them during the run |
| Context during a run | A snapshot at the start of a session, and messages | Messages and files only | New entries in each board reply |
| Agent messages | Messages through a lead, by a measured policy | An agent starts others, and they report back to it | Board entries and steers |
| History across runs | Search over every session by file, commit and pull request | Search over the threads of a workspace | Not built |
| Merge of parallel work | A checkpoint commit of the shared checkout, and branch merges | Not described. Each orb keeps its own branch. | The integration line |

The other tools are ahead on watching sessions, on history across runs and on isolation in the cloud. meld is ahead on context during a run and on the merge of parallel work. Section 2 keeps meld to that part.

## 4. The host on a VM

### 4.1 What 0.10.0 already gives

- `meld mcp --chat` lets any MCP client lead a run.
- The ACP runner starts Codex, Gemini CLI and Cursor workers.
- On a server, Claude workers can run behind the ACP adapter of Claude Code (`claude-agent-acp`). The reasons for subagents on a laptop do not apply on a server: the plan of the person and their permission rules.
- One SQLite board file is enough for one host.

### 4.2 What the host needs

1. **A start with no chat client.** For example, `meld run "<request>" --agents claude,codex,codex --repo <path>`. It starts the run, leads it to the final commit, and writes the archive.
2. **MCP over HTTP with a token for each worker.** Agents on other machines can then join a run: a session that Codecast started, a cloud agent, a laptop. A token covers one worker, one run and the board tools, and it expires with the run.
3. **The run log and the archive** of [pane-metrics-logs.md](pane-metrics-logs.md). Each run must leave evidence.
4. **Credentials for each agent CLI on the host.** A real evaluation needs API billing, because the limits of a personal plan stop long runs.
5. **A Codecast daemon on the host**, so that people see the worker sessions in Codecast.

A VM does not sleep and does not share its load with a laptop. This removes two problems of the November runs: a Mac that slept through most of a run, and runs that overlapped on one machine.

## 5. Evaluation

Two tiers, from cheap to expensive.

### 5.1 The communication simulation

Codecast tests its message policy with a simulation of a small team ([sim.py](https://github.com/codecast-sh/codecast/blob/fc0f0d8c2340edbbdb9708d9a8eacf22aaa1d67b/packages/evals/org-comms/suite/sim.py)). It has no code: facts start with one agent, other agents need them before a deadline, and the score counts facts on time, messages and delay.

- Add a shared-log mode: agents post typed entries, and each agent gets the entries it has not seen at the start of its next round.
- Add a policy text for the shared log, next to their current policy, G3.
- Add two scores: deliveries, and deliveries to agents that did not need the entry. A log sends every entry to every agent, so its cost must show.
- Compare G3 with the lead feed, the shared log, the two together, and no policy. Run the same model and effort for each arm, and mix the arms in time.

### 5.2 A coding test on VMs

- One trial is one task, one arm and one repeat. Each trial runs in a fresh VM or container from one image: the repository at a fixed commit, its dependencies, and nothing else running.
- The arms differ only in coordination: Codecast with its plan loop, Codecast with the shared log, and meld.
- The tasks must need shared knowledge. Use the long tasks of Terminal-Bench, which DeLM used, or a small repository with planted facts: a hidden limit, a shared interface, an approach that fails.
- The scores: hidden tests, time to green, cost, conflicts and repeated fails.
- At API prices, a run cost $25 to $34 in the 0.7.0 data. So start with three to five tasks and three repeats. Scale only when the data shows a difference.

## 6. Upstream

When the data is clear, propose the parts that it supports to the tools that people use:

- to Codecast: handovers in the prompt of a plan agent, a worktree for each plan agent, and the shared log as a policy variant;
- to other tools, the same parts, where their design has a place for them.

Ask the maintainers first, with the data, before you write code for their repository.

## 7. Steps

| Step | Delivers | Done when |
|---|---|---|
| h1 | The run log and the archive (steps l1 and a1 of [pane-metrics-logs.md](pane-metrics-logs.md)) | Each run on the host leaves an archive and a run log. |
| h2 | `meld run`: a start with no chat client, with Claude workers through the ACP adapter | One request with three workers goes to a final commit on a VM. |
| h3 | MCP over HTTP with worker tokens | An agent on another machine claims and finishes a task of a run on the VM. |
| e1 | The shared-log variant of the simulation | One small world for each arm gives scores. Then the full comparison. |
| e2 | The coding test on VMs | Three to five tasks, three arms and three repeats give scores. |
| u1 | A proposal to Codecast, with the data of e1 and e2 | The maintainers answer. |

## 8. Open questions

- Which VM provider, and how many trials can run at the same time?
- Does the ACP adapter of Claude Code report its usage and the names of the meld tools as meld expects? Step 10e of [plan.md](plan.md) asks the same of Codex.
- Can the Codecast daemon on a shared host show the sessions of each worker without a Linux user for each worker?
- Where does the token of a remote worker live, so that it does not appear in the logs or the transcript of the agent?
