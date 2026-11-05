# Build plan

Status: draft. The order is agreed: first make solo good and give it to people, then local parties with Claude Code and Codex, then the hosted version. Steps 0a, 0b and 0c of phase 2, and steps 10a to 10d of phase 3, are built on the branch `next`. Nothing else in phases 2 to 4 has started.

## Phase 1: solo 0.8.x for users

| Release | Delivers | Done when |
|---|---|---|
| 0.8.1 | The open findings of the 0.8.0 review: symlinks, commits on a detached HEAD in the work check, a stop during a restart, a steer that waits for merges, the guard while a discarded run is removed, the order of the integrate step, and leftover README wording. Live checks of discard and of a steer from a ready run. | Each fix starts with a failing test, and a live run passes. |
| 0.8.2 | Fewer collisions and faster workspaces: a port range, a database name and a browser profile for each worker, and one shared package cache. A run report: where the time went (model, tests, builds, waits). | A run on a real project shows no collisions, and the report gives the time shares. |

Give each release to people, and keep their problems as GitHub issues. The run report replaces the measurements of the 0.7.0 runs.

## Phase 2: the new local host (0.9)

| Step | Delivers | Done when |
|---|---|---|
| 0a | The core moves out of the plugin. `Io` splits into the ports of [architecture.md](architecture.md). An in-memory store and the conformance suite. Built: `core/`, `core/ports.ts`, `core/memory-store.ts`, `tests/store-conformance.ts` and the model test. The model test found that a stopped worker could still claim a task. | All tests pass on the in-memory store, and the plugin works as in 0.8. |
| 0b | `meld mcp` on Bun, with the SQLite store and one local party. The Claude Code plugin declares it as its MCP server and becomes its client. The 0.8 board shape moves into SQLite rows. Built as the store of the plugin (decision 41): one board for each session in `~/.meld/meld.db`, commits that compare versions, a lease of 60 s for the owner, and `/meld-resume`. The facts of the pane stay in the session state. Without Bun, the plugin works as in 0.8. Checked live: a run started in one session, a new session took it with `/meld-resume`, and delivered it. | A solo run works from start to delivery, and resumes in a new session. |
| 0c | Random characters in run ids. Parties and members. Events and context as rows that are only added, with the party column and the "uploaded" mark. Built: run ids that end with four random characters, schema 2 of the board file with its migration steps ([storage.md](storage.md)), and `tests/party-conformance.ts`. | The conformance suite covers them. |

From 0.9, users need Bun. Compiled binaries come when users ask for them.

## Phase 3: local parties with several vendors (0.10)

| Release | Delivers | Done when |
|---|---|---|
| 0.10.0 | The ACP runner. Codex workers in a local party, with the Claude Code session as the leader. Affinity. A channel for the timer of the leader, which cannot call `meld mcp` ([architecture.md](architecture.md)). | Claude Code and Codex finish one request together on one machine. |
| 0.10.x | Cursor solo and the Gemini CLI, through the same ACP runner. Built on `next`: `meld mcp --chat` gives the tools of the main session to an MCP client, and `gemini` (`npx -y @google/gemini-cli --acp`) and `cursor` (`agent acp`) are built-in ACP agents. A spec runs a chat with two stub ACP workers from the start to the delivery. Checked live with Claude Code as the chat, with no meld plugin: it started the run, read the board until the run was ready, and delivered. Not checked live: a Cursor chat, the Gemini CLI, and the agent of Cursor, which also asks questions with methods of its own, such as `cursor/ask_question`. | A Cursor chat leads a local party. |

The steps of 0.10.0:

| Step | Delivers | Done when |
|---|---|---|
| 10a | The ACP client in `mcp/acp.ts`. It starts an agent and opens a session in the folder of the worker, with its MCP servers. It sends one prompt at a time, answers each permission request with the verdict of meld, cancels a prompt, and ends with the exit of the agent. Built, with a stub ACP agent. | The specs pass against the stub agent. |
| 10b | The worker mode of `meld mcp`: the board tools of one worker of one board, from SQLite. A message to another agent becomes a row for the leader. Built: `meld mcp --worker` with MELD_BOARD and MELD_AGENT, and the `actions` table (schema 3). | A spec drives the tools of a worker through MCP: a claim, a finished task in a real git repository, and a message to the leader. |
| 10c | The leader. `meld mcp` runs the ACP workers and writes their activity to the board. The plugin starts a `codex` agent through `meld mcp`, and its pane reads the board over a Unix socket. Built: the ACP runner in `mcp/leader.ts`, the board channel in `mcp/channel.ts`, one host that starts each worker again (the plugin its Claude workers, `meld mcp` its ACP workers on its beat), and `mcp/run.spec.ts`. That spec found that the ACP client did not wait for an async verdict, so each permission request of an ACP agent got the answer cancelled. | A run with one Claude worker and one stub ACP worker goes from start to delivery. |
| 10d | Affinity: an idle worker continues its session while its context stays under a share of the window of its model. Else a fresh agent starts with the handover. Built: the share is one half. A Claude worker gets its context from each model call, and an ACP worker from `usage_update`. A live check in this session showed that a message to a subagent that ended its turn continues it with its context. | Tests cover both cases, for Claude workers and for ACP workers. |
| 10e | A live run with Codex (`npx -y @agentclientprotocol/codex-acp`) on a machine with an OpenAI login. Check these open points: the name that Codex gives to the tools of meld (the prompts say `mcp__meld__board`), whether Codex reports its MCP calls as tool calls (then the leader counts each board call twice), the approval mode of Codex against the verdicts of meld, and whether codex-acp sends `usage_update` (without it, a Codex worker gets a new agent for each task). | Claude Code and Codex finish one request together. |

The upkeep of the board file:

| Step | Delivers | Done when |
|---|---|---|
| u1 | A write that changes nothing stores nothing: the version of the board stays, and the plugin calls `commit_board` only for a change. Built. | The specs of both stores pass. |
| u2 | A record of each run in the board file (the table `runs`, schema 4), which `/meld-clean` reads through `run_records`. meld writes and reads no `board.json`. Built. | `/meld-clean` lists and removes a folder from the record of its run, and no write makes a `board.json`. |
| u3 | A retention rule: at its start, `meld mcp` removes the rows older than 30 days that no step needs: boards with no run or a delivered run, records of runs with no board and no folder, their events, old actions and members. The context stays. Built. | The specs of each rule pass, and a start of `meld mcp` removes an old empty board. |
| u4 | A backup each day: before the prune, `meld mcp` copies the board file with `VACUUM INTO` to `backups/meld-<date>.db`, through a part file. The five newest copies stay, open to their user only. Built, with the steps to restore a copy in [storage.md](storage.md). | A start makes the copy of the day, a second start that day makes none, and a copy that fails leaves no file. |

## Phase 4: hosted (later)

| Step | Delivers | Done when |
|---|---|---|
| 1 | `meld serve`, hosted, with the Postgres store, HTTPS, logins, worker tokens, hosted parties with their queues, and the first cloud driver (a team's sandbox sessions). Merges with git plumbing on a bare clone. Delivery as a draft pull request. | One party with three sandbox sessions finishes one request as one pull request. |
| 2 | Share knowledge with a hosted party: the outbox, `grep_context` across both stores, and the share setting. | Solo runs feed a hosted party. |
| 3 | Join a hosted party: the API that members use to ask for work. | A local session and cloud agents finish one run of a party together. |
| 4 | Promote. The Cursor cloud and Devin drivers. | A local party moves to the hosted service, and cloud agents finish its runs. |

The model-based tests of the proposal (no task has two owners, a parent is done when its parts are done, and dependencies form no cycle) go into step 0a, so they cover every host. Parties add one more: no worker slot holds two tasks.

## Open points of 0.10

- The writes of ACP workers do not renew the lease of the session that owns the board. While the main session waits through a long Codex prompt, another session can take the board with `/meld-resume`.
- A message of an ACP worker to a Claude worker waits for the next end of a turn of the main session.
- When one task is ready and two workers are idle, the restart rule gives the task to the first idle worker. When that worker is a Claude worker, the task waits for the next end of a turn of the main session, while an idle Codex worker could start at once. A better rule can prefer the worker that did the tasks that the task needs, then a worker whose host acts now.
- A SIGKILL of `meld mcp` leaves its ACP agents running, when they do not stop at the end of their input.
- Two chats on one folder lead the same board, as no lease holds it. Then both start its idle ACP workers again.
- The repository has no package file, so nothing checks the types of `mcp/`, which needs the types of Bun. A check with `bun-types` 1.4.4 passes today, and it would have found the verdict that the ACP client did not wait for.

## Open choices

- In phase 4: share knowledge or join a party first. The proposal is share knowledge: it is small and safe, and every solo run starts to feed the team.
- The Devin token: a narrow token in the prompt with the risk accepted, or wait for secrets for each session.
- Path claims: warnings only, or refusals later.
- The open questions of [parties.md](parties.md).
