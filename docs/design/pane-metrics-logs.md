# The pane, the system metrics and the logs

Status: draft. The note is checked against meld 0.10.0 (`main` at `8077ba6`). It is also checked against local runs from 5 to 9 November 2026 and against issues #4 to #12. Section 1 adds one run of 10 November 2026 on 0.10.1.

0.10.1 builds four parts of this note:

- the reason in each refusal (item 7)
- a warning for a run with no board file (item 8)
- a first archive of each run (section 6.6)
- cost units in the token count (item 3)

The pane, the metrics and the logs are not built.

This note gives a new design for the pane, a set of system metrics, and a strategy for the logs and records of meld. Section 1 gives the evidence. The other sections give the design.

## 1. Evidence

### 1.1 The runs

The runs ran on one machine from 5 to 10 November 2026. This note gives the data of three of them: two on a personal project, and one on meld itself. Runs on other projects give lessons only, with no data.

| Run | Agents | Version control | Tasks done | State at the end |
|---|---|---|---|---|
| `mw39gfifqits` | 1 Claude, 2 Codex | jj | 4 of 4 | stopped |
| `mw3antkq04bh` | 1 Claude, 2 Codex | jj | 9 of 9 | ready |
| `mwajbtef7xze` | 2 Claude | git | 6 of 6 | delivered; 0.10.1, a session with no person |

### 1.2 Metrics measured from the board file

The numbers below come from the task times and the events of each run. A worker counts as busy while it holds a claim. The window runs from the first task event to the final commit, or to the last task event. Section 1.4 gives the limits of this method.

| Run | Window | 3 busy | 2 busy | 1 busy | 0 busy | Balance | Largest share of work | Entries read by another agent | Checks failed | Steers |
|---|---|---|---|---|---|---|---|---|---|---|
| `mw39gfifqits` | 7 min | 5 | 2 | 0 | 0 | 0.88 | w3 (Codex), 50% | 14 of 14 | 1 of 10 | 0 |
| `mw3antkq04bh` | 41 min | 4 | 11 | 23 | 3 | 0.88 | w1 (Claude), 56% | 23 of 28 | 5 of 25 | 0 |

Balance is the mean busy time of the workers divided by the largest busy time. Share of work is the done weight of each worker (S 1, M 3, L 8).

### 1.3 What the runs and the issues show

1. **The machine slept through most of a run, and meld recorded nothing.** In one run, the Mac went to idle sleep on battery for most of the run. The board showed ready tasks and idle workers for that time, and one very long task, but the sleep log of the Mac explains both. Nothing in the pane or the board said that the machine had slept.
2. **"Read" tells nothing.** In the runs of section 1.2, 37 of 42 entries reached at least one other agent. A board reply carries each new entry to every agent, so "read" means "delivered". It does not show use.
3. **The cost in the pane is too low.** Issue #6 measured 9 runs and 3,980 model calls. Cache reads are 80% of the cost of a run, and the pane left them out (`freshTokens`). 0.10.1 counts each token at its price against input. ACP workers still show 0 tokens.
4. **Contexts grow with no limit.** A Claude worker grows from about 80k to 400k-570k tokens in a task, and never compacts. A worker keeps its session from task to task while its context uses less than half of its window (`AFFINITY_SHARE`). On a window of 1M tokens, that is up to 500k (issue #6 and its comments). In 0.10.1, a `meld:worker` compacts at the cap of 150k and goes on. In `mwajbtef7xze`, the workers compacted at 117k and 120k, and each summary kept the claimed task.
5. **A worker waits for its own background work, and meld does not see it.** In one run, a worker watched a finished job with `tail -f`. The board showed it as idle, and meld did not start it again (issue #4, comment).
6. **meld starts idle workers again when no task is left.** In one run, meld kept starting a worker after all tasks were done. Each start cost tokens.
7. **A failed hook hides its error.** In one run, every board call failed after one write with a fixed text: "meld: the board failed. Try the call again." The hook catches the error and logs nothing (issue #7). In 0.10.1, the refusal gives the kind and the reason of the failure.
8. **A run with no board server leaves no record.** In one run, `meld mcp` did not start, because the session was parked when the run began. The run lived in the session state. Only one field of a board reply said so: `"store": "the session state"`. The run has no record, no events and no archive. In 0.10.1, a start with no board file says so.
9. **The history of a run goes after 30 days.** The prune removes the board, the record and the events of an ended run. Only the context entries stay (issue #5). The person archived two runs by hand. 0.10.1 writes an archive file before Deliver, Discard or a new start removes a run.
10. **The person drives the run with steers.** In the run on the sleeping machine, the person steered after the wake. Most of the steers told idle workers to claim ready tasks, or chose the integrator. The board does not show if meld would have started the workers without them.
11. **The share of each agent kind varies.** With one Claude worker and two Codex workers, the Claude worker did 56% of the work in `mw3antkq04bh` and 25% in `mw39gfifqits`. Three runs are too few to compare agent kinds.
12. **Workers could not commit in a session with no person.** In `mwajbtef7xze`, the shell of each worker started in the folder of the session, not in its own folder. So a worker ran `git -C <its folder>`, and Claude Code asked a person for that form. With no person, the ask became a refusal, and no task could finish. 0.10.1 allows `git -C` and `jj -R` in the own folder of a worker, for the commands of its guide.
13. **Restarts wait for a turn of the main session (issue #12).** In `mwajbtef7xze`, two workers finished their tasks and then stayed idle for 10 minutes, with three tasks open. In a session with no person, a hand-back started no turn of the main session. A turn that a script sent every 2 minutes started the workers again.

### 1.4 Limits of the measurement

- A stalled worker that holds a claim counts as busy. Item 5 of section 1.3 shows that this happens.
- The board file cannot tell a sleeping machine from idle workers. The sleep log of the operating system shows a sleep.
- The board file has no time for the start of a worker or for planning. The window starts at the first task event.
- The busy time of a worker is from its claims. It does not split the time into model, tools and waits.

Section 5 gives the records that remove these limits.

### 1.5 Problems in the pane

| Problem | Part of the pane | Cause |
|---|---|---|
| Every task and the request show 0% for most of the run. | Progress | A leaf counts as 0 until its finish. A run with three tasks shows 0% until the first finish, and then 33%. The bar shows the claimed part in colour, but no number names that part. |
| An agent row shows a raw command or tool name: `git <folder>`, `grep "<pattern>`, `ToolSearch`. | Agents | `activityOf` shows the last tool, and the first word and target of a command. |
| A Codex worker shows `Guardian Review` for a long time. | Agents | The ACP runner records the title of each tool call that the agent reports. meld does not know this step of Codex. The person cannot tell if the worker waits, reviews or works. |
| An agent row gives the id of its task, not the title. | Agents | The row has space for a few characters only. |
| The tree of tasks does not show. | Progress | Each parent stays closed until the person presses it. The block stops at 90 words, and the rest shows as "7 more". |
| The call count and the seconds since the last tool tell the person little. | Agents | They are the only live numbers that meld keeps for a worker. |
| The cost leaves out ACP workers. | Header | Since 0.10.1, `costTokens` counts each token at its price against input. ACP workers report no tokens to the pane. |
| Ready tasks and idle workers show no warning. | All | The pane has no view of the queue against the workers. |
| The pane and the board do not show that the machine slept. | All | meld records no sleep or wake, and nothing keeps the machine awake during a run. |
| The person cannot see if the agents use the shared context. | All | The pane shows the newest entries, but not who used them. |
| When a call fails, the person sees a fixed text, and the developer has no log to read. | All | meld writes no log file. The hooks change each error into a fixed text. `meld mcp` writes three kinds of lines to standard error, and it keeps the standard error of an ACP agent in memory only. |
| The pane does not say when a run has no board file. | Header | Only a field of the board reply says that the run lives in the session state. |

## 2. Goals

1. The person can answer these questions from the pane:
   - Which task does each agent do?
   - What does each agent do now?
   - What did each agent finish?
   - Where do the time and the cost go?
   - Do the agents work together and learn from each other?
   - Is a task ready while an agent is idle?
2. The pane makes no model calls.
3. The terminal and the graphic surfaces show the same facts.
4. The system metrics are the same in the pane, in the run report, and across runs.
5. A developer can find why a run failed from one log file.
6. The record of a run stays after its workspaces go.

## 3. The pane

The pane has two views:

- **Main view**, while the run starts or works, in this order: the header (3.1), the agents (3.2), the conversation (3.3), the learnings (3.4), the plan (3.5), and the steer box (3.6).
- **Report** (3.7), when the run is ready, delivered or stopped. It replaces the main view.

The main view tells what happens now, in words. The numbers, the Flow lanes and a recap of each agent are in the report only. The metric functions of section 4 serve both views.

### 3.1 Header

- The state, the number of agents, the time since the start, and the cost. The cost is in dollars where the host keeps a cost ledger, else in cost units. It includes cache reads, and the usage that ACP workers report. The header has no call count.
- The request in two lines. A press shows all of it.
- One line of counts in place of a percent: `9 of 14 tasks done, 3 working, 1 ready, 1 waiting`. A count of zero is left out.
- One bar with three parts: done, working, and open. The counts name the parts.
- A warning line, only when a warning holds, the most important first:
  1. The machine slept during the run: `The machine slept for 159 minutes. Nothing ran in that time.`
  2. The run has no board file: `This run lives in the session state. It has no record, and no other session can resume it.`
  3. The newest error of the run log, with its message, for example `board call failed: <message>`. A press runs `/meld-log`.
  4. The newest warning of the run log.

A ready task with an idle agent shows on the card of that agent (3.2), not in the header.

### 3.2 Agents

One card for each agent, with three lines:

| Line | Content | Source |
|---|---|---|
| Title | The colour of the agent, the worker id, the agent, the id and title of its task, and the time on the task. An agent with no task says `no task now`. | The board |
| Now | What the agent does now, in its own words: its last sentence, at most 20 words | A worker that the host runs: the `answer` of its last `turn.step`, which the hook already receives. An ACP worker: the text of its `agent_message_chunk` updates in the current prompt, or the `plan` entry in progress. |
| Did | The titles of the tasks it finished, newest first, each with a tick. One line, then `and N more`. | `finish_task` |

When the agent wrote no text for 60 s, the Now line shows plain words from the kind of its tool calls:

| Words | Host tools | ACP tool kind | Commands |
|---|---|---|---|
| reading code | Read, Glob, Grep | read, search | `cat`, `rg`, `grep`, `find`, `ls` |
| editing `<file>` | Edit, Write, MultiEdit, NotebookEdit | edit, delete, move | |
| running tests | | execute | the test rules of section 4.3 |
| building | | execute | the build rules of section 4.3 |
| running the app | browser tools | execute | the app rules of section 4.3 |
| waiting for its background work | a background shell that is still running | | `tail -f`, `sleep`, `until` loops |
| using the board | the meld tools | the meld tools | |
| waiting for approval | | an open permission ask | |
| in a step of the agent: `<title>` | any other tool | think, other | |

A card has two buttons: **Transcript**, where the host can open the transcript of the agent (`$.ui.view({ agentId })`), and **Stop**.

An idle agent with a ready task gets one chip, `#20 is ready since 6 min`, with a **Start** button. The chip is the only warning a card shows.

A card shows no context, cost, counts, commands or shares. The context and the cost of each worker are in the report. The last command of an agent goes to the run log.

### 3.3 Conversation

A feed of what the agents and the person say to each other, oldest first. Each line has its time, `HH:MM`:

- **Notes** of the agents: `w2 -> all`, and the text of the note.
- **Handovers** from one agent to another: when a task finishes and the task of another worker needs it, `w3 -> w1`, and the unfinished work of the handover, else its summary.
- **Steers** of the person: `you -> all`, in a box of the colour of the person.
- **Merges and conflicts** of meld, as quiet lines: `Merged #13 into the line.`, `#14 conflicted with #12. w2 integrates it as #18.`

The feed shows the newest lines that fit in 100 words. The source is the log of the run: note, steer, merge and task entries, and the handovers of finished tasks.

### 3.4 Learnings

The current shared context as sentences, in three groups:

- **Facts:** the fact entries.
- **Avoid:** the fail entries.
- **Contracts:** the interface entries.

Each line shows the first sentence of the entry, at most 20 words, the worker that shared it, and one of:

- `used by w2, w3`: the workers whose `finish_task` named it in `used`.
- `heeded by w1`, for a fail that a `finish_task` named in `used`.
- `got by 2`: the number of agents that a board reply carried it to, when no finish named it.

The newest entries come first in each group. The block shows the newest entries that fit in 100 words.

- "got" replaces "read" of earlier versions: a reply carries each new entry to every agent, so it shows delivery, not use. "used by" and "heeded by" are the claims of the agents.
- The worker rules ask each finish for the ids of the entries that helped, in `used`. meld keeps the ids that name an entry of the run, once each.
- The main view has no metrics line. The metrics of section 4.4 are in the report.

### 3.5 Plan

- The tasks show as a tree, under the heading Plan.
- A parent opens itself when a task under it is claimed or ready.
- A parent closes itself when all of its tasks are done.
- The person can open and close a parent. The choice of the person stays until the run ends.
- A leaf shows a word, not a bar or a percent:
  - the worker id and `working`, in the colour of the worker
  - `ready`, with the time since it became ready, for example `ready 6m`
  - `waits for #N`
  - a tick and `done`
- A ready task that waits more than 5 minutes while an agent is idle shows in the warning colour.
- A parent shows `N of M done`.
- In each level, the order is: claimed, ready, waiting, done. So a plan with no parents shows in the same order.
- The word limit of the block counts the live rows first. While a task is live, the done top-level rows fold into one line: `#1 Metrics, and 3 more done`.

### 3.6 Steer box

One box, `Steer all agents`, and a row of presets: `+ Tests`, `Smaller`, `Fix checks`, `Integrate now`. A steer goes to every agent, and the conversation shows it. In a ready run, **Ask for changes** opens the box.

### 3.7 Report

When the run is ready, delivered or stopped, the report replaces the main view. meld also writes the report to the archive of the run (section 6.6), so the person can share it, and `/meld-report` prints it. The workspaces folder is not a place for it: Deliver and Discard remove that folder.

The report has these parts:

1. **Header**, as in 3.1.
2. **Final commit:** the short commit, the number of files, and the checks, for example `7e1a0c3 - 24 files - all 3 checks pass`. Four buttons: **Deliver**, **Show diff**, **Ask for changes**, and **Discard**.
3. **Story:** the run in at most five sentences. meld fills a fixed template with the metrics of section 4. No model writes it. An example from the picture:

   > Three agents finished 22 tasks in 1 hour 48 minutes. They shared 33 learnings, and used 7 of them in later tasks. Two fails stopped the others from the same dead end. For 14 minutes only one agent worked. You steered once.

4. **What each agent did:** one card for each agent, with the worker id, the agent and a **Transcript** button; the titles of its finished tasks in one sentence; and three counts: `8 tasks`, `shared 12 learnings`, `used 3`.
5. **Timeline:** the Flow lanes of the whole run, with a time axis under them.
   - One lane for each worker, with five kinds of parts:
     - **working** on task #N.
     - **merging** task #N into the integration line.
     - **waiting on meld:** the worker is idle while a task is ready for it, a restart is pending, or an approval is pending.
     - **idle:** no task is ready.
     - **asleep:** the machine slept. A band across all lanes shows it.
   - A graphic surface draws the lanes as SVG, with the parts in words for a screen reader. The terminal draws one row of cells for each worker, with one shape for each kind.
   - Under the lanes, three numbers from section 4.1: the agents at work on average (parallelism), the share of the time that one agent worked alone, and the cost per finished task.

The text of `/meld-report` and of the archive adds the metrics of section 4 for the run and for each worker.

## 4. System metrics

The metrics answer six questions. Each metric has one definition, and the pane, the report and the hosted service use the same one. Section 5 gives the records that each metric reads.

Words in this section:

- **Worker time:** the time from the start of a worker to its stop, or to the end of the run.
- **Busy:** a worker works on a task or merges a task. A worker that waits for its own background work, or makes no call for `STUCK_MS`, is not busy.
- **Weight:** the size weight of a task: S 1, M 3, L 8 (`SIZE_WEIGHT`).
- **Cost units:** tokens weighted by their price: input 1, cache write 1.25, cache read 0.1, output 5. The pane gives dollars where the host gives a price.

### 4.1 Efficiency: does the parallel work pay?

| Metric | Definition | Good | Bad | Measured |
|---|---|---|---|---|
| Busy share | Busy time of all workers / worker time of all workers | Over 80% | Under 60% | 46% and 90% |
| Effective parallelism | Busy time of all workers / time of the run | Near the number of workers | Near 1 | 1.4 and 2.7 |
| Waiting on meld | Time in which a worker waits for a restart, an approval or a merge | Under 5% of worker time | Over 10% | Not recorded |
| One agent alone | Time in which only one worker is busy / time of the run | Under 10% | Over 25% | 0% and 56% |
| Machine asleep | Time in which the host machine slept during the run | 0 | Over 0 | Seen in one run |
| Idle restarts | Starts of a worker with no task ready for it | 0 | Over 0 | Seen in one run |
| Rework | Releases, `integrate #N` tasks and failed checks, for each finished task | 0 | Over 0.3 | 0.25 and 0.56 |
| Cost per finished task | Cost of the run / finished tasks | Falls from run to run | Rises | Not recorded |
| Cache read share | Cost units of cache reads / all cost units | Under 50% | Over 70% | 80% (issue #6) |
| Context per call | The mean and largest context of each worker, against the cap | Under the cap | Over the cap | Mean 141k to 297k, largest 569k (issue #6) |
| Time by activity | Shares of worker time: model, tests, builds, app, other tools, board, merge, waiting, idle | Model and tests lead | Idle or waiting leads | Not recorded |

The measured values come from the two runs of section 1.2, and from issue #6.

### 4.2 Progress: how far is the run?

| Metric | Definition |
|---|---|
| Done weight | Weight of done tasks / weight of all tasks. It replaces the percent of today, and the pane shows it with the counts. |
| Counts | Done, working, ready and waiting tasks. |
| Ready with no agent | Tasks that are ready while a worker is idle and the machine is awake, now and as minutes so far. |
| Scope growth | Tasks added after the first plan / tasks of the first plan. A high value says that the plan was too coarse. |
| Rate | Done weight in the last 10 minutes. |
| Critical path left | The longest chain of needs among the open tasks, in tasks and in weight. The run cannot end before this chain. |
| Blocked | Tasks that wait for a need, and the task that blocks the most of them. |

meld gives no time of arrival. The rate and the critical path show where the run is. A time of arrival from these numbers would look precise and be wrong.

### 4.3 Collaboration: do the agents work together?

| Metric | Definition |
|---|---|
| Cross needs | Tasks whose needs another worker did / tasks with needs |
| Handovers used | Claims whose reply carried a handover (commit, interfaces or unfinished work) |
| Commits taken | Commits that a worker took from the lane of another worker (`jj new`, `git merge` or `git cherry-pick` in its lane) |
| Splits for others | Parts of a split that another worker claimed |
| Conflicts | `integrate #N` tasks, and the files in them |
| Overlap | Files that two lanes changed, from the diffs at merge time. A high overlap with no conflict can still be duplicated work. |
| Steers | Steers of the person, and the share of them that start idle workers or choose an integrator. Such steers do the work of meld, so a high share shows a gap in meld. |

The activity classes of sections 3.2 and 4.1 use these rules on a command, in this order:

- **tests:** a test runner (`pytest`, `vitest`, `jest`, `bun test`, `go test`, `cargo test`, `npm test`, `npm run test`), or a description that names tests.
- **builds:** `tsc`, `build`, `compile`, an install of packages.
- **app:** a dev server, a request to `localhost`, a browser tool.
- **background waits:** `tail -f`, `sleep`, and `until` loops.
- **other tools:** all other commands.

The rules live in one table in `core/`, with tests. They come from the analysis script of the 0.7.0 runs.

### 4.4 Shared context: do the agents learn from each other?

| Metric | Definition |
|---|---|
| Entries | Entries for each finished task, by kind: fact, fail, interface |
| Delivered | Entries that a board reply carried to at least one other agent / all entries. This is `seenBy` today. It is high, because each reply carries each new entry to every agent. It is a check that delivery works, not a measure of use. |
| Time to delivery | Time from an entry to its first delivery |
| Cited | Entries that a finish names in `used` / entries that its worker received. This needs a new optional field `used` in `finish_task`: the ids of the entries that helped. |
| Fails heeded | Fail entries whose receivers did not share a fail with the same files after they received it / fail entries with receivers |
| Repeated fails | Fail entries with the same files from two workers, where the second worker received the first entry before its own |
| Across runs | Entries of earlier runs that a run received, and the share of them that it cited. This needs the search of [shared-context.md](shared-context.md). |

"Cited" is the claim of the agent. "Fails heeded" and "repeated fails" do not depend on a claim. The report shows all of them, so that the person can compare them.

### 4.5 Workload: is the work fair and balanced?

| Metric | Definition | Fair |
|---|---|---|
| Share of work | Done weight of each worker / done weight of the run | 1 / number of workers |
| Balance | Mean busy time of the workers / the largest busy time | Near 1 |
| Spread | The coefficient of variation of busy time: standard deviation / mean | Under 0.25 |
| Largest task share | Weight of the largest task / weight of all tasks | Under 1 / number of workers |
| Idle while others work | For each worker: its idle time while another worker is busy | Near 0 |
| Agent mix | The share of work for each agent kind (Claude, Codex, Gemini, Cursor) and its rework | Same rework for each kind |

Balance of busy time and share of work can disagree. In one run, the busy times were equal, but one worker did almost half of the weight. The report shows both.

A run can be fair and slow, or unfair and fast. So the pane shows balance together with "one agent alone". In the run on the sleeping machine, the sleep caused most of the imbalance. In the 0.7.0 runs, one large task at the end caused it. The first needs a machine that stays awake. The second needs a smaller task.

### 4.6 Across runs

The archive of each run keeps its metrics (section 6.6). `/meld-report --runs` shows a table of the last runs: agents, tasks, time, busy share, one agent alone, ready with no agent, balance, cited, rework, cache read share, and cost per finished task. So the person can see if a change of meld, of the agents or of the request style helps. The hosted service shows the same table for a party.

## 5. Records

### 5.1 What the metrics need

| Record | Today | Change |
|---|---|---|
| Worker states over time | The current state and the time of the last activity | A `worker` event at each change: working, idle, waiting (with the reason: restart, approval, merge, background work), stopped |
| Worker starts | `goes on in its session` events for some restarts | A `worker` event for each start, with its reason, and a mark when no task was ready |
| The words of the agent | None | `said` and `saidAt` on the worker, from the `answer` of `turn.step` or from `agent_message_chunk`. The first sentence, at most 20 words. |
| Time by activity | The last activity only | A sum of milliseconds for each activity class, for each worker and for its task. The tool hook times each tool call of a Claude worker. The ACP runner times each tool call from its first update to its `completed` update. |
| Model time | None | The time around each `turn.step` of a Claude worker. For an ACP worker: the time of a prompt minus its tool time. |
| Tokens by kind | `tokens` in cost units since 0.10.1, and 0 for ACP workers | Sums of input, cache write, cache read and output tokens for each worker and task. For ACP workers, the usage that the agent reports, or "not reported". |
| Context | `context.used` at the last call | The largest context of each agent, and the starts of fresh agents at the cap |
| Merges | A log entry with no duration | The start and the end of each merge, and its files |
| Receivers of an entry | `seenBy` in the run, which is trimmed | One `delivered` event for each worker and entry, so the receivers stay after the trim |
| Citations | None | The optional `used` field of `finish_task` |
| Commits taken | None | At finish, the lane commits whose author is another worker |
| Store of the run | One field of the board reply | A `store` field on the run record, and an event when the run moves to the board file |
| Sleep of the machine | None | A host event at each sleep and wake, from the power log of the operating system or from a gap in the clock |

Rules for these records:

- Keep sums, not one row for each tool call.
- Write the new fields in the store commit that each step already makes. Add no extra writes.
- The run shape becomes `run-5`.
- Each metric is a pure function of the run and its events, in `core/metrics.ts`, with tests. The tests include the runs of section 1.2, from their archives.

### 5.2 What the metrics leave out

- The quality of the code. Checks and review give that, not the board.
- The thinking of the agents. It stays in the transcripts.
- An exact cost of ACP workers that report no usage. The report says "not reported", not 0.

## 6. Logs and archives

### 6.1 Four records, four jobs

| Record | Job | Place | Kept |
|---|---|---|---|
| Board events | What happened in a run, for the person, the pane and the metrics | The `events` table | 30 days in the board file, and for all time in the archive |
| Run log | Why it happened, for the developer and for bug reports | `~/.meld/logs/<run>.jsonl`, then the archive of the run | 30 days |
| Host log | The life of each `meld mcp`: start, connection, schema, backup, prune, socket, sleep and wake of the machine, end | `~/.meld/logs/mcp-<date>.jsonl` | The 5 newest files, as for the backups |
| Archive | The whole record of an ended run, for history and for metrics across runs | `~/.meld/archive/<run>/` | For all time, except the run log |

The board events and the archive are part of the product. The logs are for debugging. A metric never reads a log.

### 6.2 The format of a line

Each line is one JSON object:

```json
{"at":"2026-11-05T15:15:18.120Z","level":"error","src":"hooks","run":"r1","worker":"w2","agent":"claude","task":12,"event":"board.call","ms":38,"ok":false,"detail":"<the message of the error>"}
```

- `level`: error, warn, info or debug.
- `src`: hooks, mcp, leader, acp, worker, vcs or store.
- `event`: a name from one constant list in `core/log-events.ts`, for example `board.call`, `control.call`, `git.run`, `acp.request`, `acp.tool`, `acp.permission`, `acp.stderr`, `mcp.connect`, `worker.start`, `lease.lost`, `commit.retry`, `merge`, `backup`, `prune`, `hook.slow`.
- `run`, `worker`, `agent` and `task` link a line to the board.
- `detail`: at most 300 characters.

Tests and tools search the event names, not the text.

### 6.3 What to log

At error:

- Each error that a hook catches, with its message and the top of its stack. Issue #7 shows the cost of a hook that changes each error into a fixed text. The deny text that the agent receives also starts with the message.
- Each failed connection to `meld mcp`, with the reason that the engine gives.
- Each failed backup or prune.

At info:

- Each board call: the tool, the worker, the task, the result code and the time.
- Each git and jj command: the arguments (at most 200 characters), the exit code and the time. For a failure, the last 5 lines of standard error.
- Each start, restart, resume and stop of a worker, the rule that chose it, and whether a task was ready.
- Each ACP request and response: the method and the time.
- Each ACP tool call: its title, its kind and its time. This answers what a step such as `Guardian Review` is, and how long it takes.
- Each ACP permission ask: the title, the kind, the paths and the verdict of meld.
- Each line of standard error of an ACP agent.
- Each lost race and retry of a store commit.
- Each take, renewal and loss of a lease.
- Each merge and its result.
- Each hook that uses more than half of its time limit.
- Each sleep and wake of the machine during a live run.

At debug, with `MELD_LOG=debug`: each ACP update kind, and the size of each board reply. The size of the run in the session state is part of this, as issue #7 suspects a limit there.

Never:

- The text of prompts, or the text of the model beyond the `said` sentence on the board.
- The contents of files.
- The environment, tokens and keys.

Commands go through a redaction of known secret shapes before they go to the log: authorization headers, `--password` and `--token` values, and key prefixes such as `sk-` and `ghp_`. The redaction has its own tests.

### 6.4 One writer

The hooks do not write files. Each store commit of the hooks to `meld mcp` carries the log lines of that step, and `meld mcp` appends them. A worker of `meld mcp --worker` appends its own lines with the same function.

When `meld mcp` does not connect, the hooks keep the lines in the session state, at most 500. They also send each warning and error to the debug log of Claude Code with `$.ui.log(text, { to: 'debug' })`. When the run moves to the board file, `meld mcp` writes the kept lines first.

A run log stops at 20 MB. Its last line then says that the log is full.

### 6.5 How people read the logs

- The warning line of the pane header shows the newest error or warning.
- `/meld-log` shows the path of the run log, the counts for each level, and the last 10 warnings and errors.
- `/meld-log --bundle` writes one file for a GitHub issue: the archive of the run and its run log, after the redaction.
- A conformance test gives each store and host a log port. The tests check the event names.

### 6.6 The archive of a run

This section answers issue #5.

0.10.1 builds a first form: before Deliver, Discard or a new start removes a run, meld writes one file, `~/.meld/archive/<run>.json`, with mode 600. It holds the run, the board (the request, the steers and the tasks), the events and the context entries. When meld cannot write it, the run and its folder stay. The folder below adds the report and the run log.

Before meld removes the folder of a run, it writes the archive of the run. This applies to Deliver, Discard and `/meld-clean`. For a run in the session state, the archive comes from the copy in the session state.

The archive is one folder, `~/.meld/archive/<run>/`:

| File | Content |
|---|---|
| `run.json` | The run record, the last board (request, steers, tasks, summaries and handovers), all events, and the context entries with their receivers. The two archives that the person made by hand have this shape. `run.json` adds a shape tag and the version of meld, so a later meld can read it. |
| `metrics.json` | The metrics of section 4 for the run and for each worker |
| `report.md` | The report of section 3.7 |
| `log.jsonl` | The run log, kept 30 days |

- meld writes each file to a part file first, and then gives it its name, as for the backups.
- The folder is open to its user only (0700), and each file too (0600).
- `/meld-report <run>` and `/meld-report --runs` read the archive when the board file no longer holds the run.
- A hard delete of a secret covers the board file, the archive and the backups.
- The hosted phase uploads archives with the outbox.

The backups folder was empty on 9 November 2026, though `meld mcp` keeps 5 daily copies. SQLite 3.51 (in Bun 1.4.4) refuses `VACUUM INTO` a file that is there, and meld made an empty part file first. So no backup ever worked on that machine. A failed backup went to standard error only, so nobody saw it. 0.10.1 fixes the copy. The host log of section 6.1 records each failed backup.

## 7. Steps

| Step | Delivers | Done when |
|---|---|---|
| l1 | The run log, the host log, the redaction, `/meld-log`, the warning line, and the error text in the deny text | A spec reads the run log after a failed board call and after a failed ACP start. The redaction tests pass. |
| a1 | The archive of section 6.6 at Deliver, Discard and `/meld-clean` | A spec archives a run in each case. `/meld-report <run>` reads a run that the prune removed. |
| p1 | Counts and done weight in place of percents. Words on leaves. The tree that opens around live work. The ready-and-idle warning. | Pane tests pass for a plan with no parents and for a tree. The shots show a run with 13 tasks. |
| p2 | The agent cards: title, Now, Did, Learned, context and cost, warnings, Open transcript | Tests pass for a Claude worker and for an ACP worker, with and without words from the agent. |
| m1 | The records of section 5 and `core/metrics.ts` | A model test: for each worker, the parts of its lane add up to its worker time. The metrics of the archived runs match section 1.2. |
| f1 | The Flow section | The shots show the lanes on the terminal and on a graphic surface. |
| r1 | The report in the pane, `/meld-report` and `/meld-report --runs` | A live run with Claude and Codex workers gives a report and a story. |

The proposed order is l1, a1, p1, p2, m1, f1, r1. Issue #7 and the lost history of issue #5 cost the most in the runs, so the logs and the archive come first.

Three fixes that the evidence asks for are not part of this note: the context cap (issue #6), a machine that stays awake during a live run, and idle restarts with no task left. To keep a Mac awake, `meld mcp` can hold `caffeinate -i -w <pid>` while it leads a live run. The pane and the metrics make each of them visible, and the metrics show if a fix works. 0.10.1 builds the context cap.

## 8. Open questions

- Would meld have started the idle workers after the wake of a sleeping machine, without a steer? The run log of step l1 records each restart decision and its rule, so the next run answers it.
- What is the `Guardian Review` step of Codex? Does it repeat the verdicts of meld? The run log answers this. If Codex reviews each command itself, set its approval mode so that meld gives the verdicts (step 10e of [plan.md](plan.md)).
- Does codex-acp report its token usage? Issue #6 found that Codex workers compact near 180k, but the pane shows 0 tokens for them.
- When an agent writes no text, should the Now line use its thinking? The proposal is no: the thinking stays in the transcript.
- If the words of the agents are too thin, a small model can write a summary of each task at its finish. The proposal is to wait for live runs first.
- Do agents fill `used` in `finish_task` with care? Compare it with "fails heeded" over a few runs before the report gives it weight.
