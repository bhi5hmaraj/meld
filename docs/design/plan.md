# Build plan

Status: draft. The order is agreed: first make solo good and give it to people, then local parties with Claude Code and Codex, then the hosted version. Nothing in phases 2 to 4 has started.

## Phase 1: solo 0.8.x for users

| Release | Delivers | Done when |
|---|---|---|
| 0.8.1 | The open findings of the 0.8.0 review: symlinks, commits on a detached HEAD in the work check, a stop during a restart, a steer that waits for merges, the guard while a discarded run is removed, the order of the integrate step, and leftover README wording. Live checks of discard and of a steer from a ready run. | Each fix starts with a failing test, and a live run passes. |
| 0.8.2 | Fewer collisions and faster workspaces: a port range, a database name and a browser profile for each worker, and one shared package cache. A run report: where the time went (model, tests, builds, waits). | A run on a real project shows no collisions, and the report gives the time shares. |

Give each release to people, and keep their problems as GitHub issues. The run report replaces the measurements of the 0.7.0 runs.

## Phase 2: the new local host (0.9)

| Step | Delivers | Done when |
|---|---|---|
| 0a | The core moves out of the plugin. `Io` splits into the ports of [architecture.md](architecture.md). An in-memory store and the conformance suite. | All tests pass on the in-memory store, and the plugin works as in 0.8. |
| 0b | `meld mcp` on Bun, with the SQLite store and one local party. The Claude Code plugin declares it as its MCP server and becomes its client. The 0.8 board shape moves into SQLite rows. | A solo run works from start to delivery, and resumes in a new session. |
| 0c | Random characters in run ids. Parties and members. Events and context as rows that are only added, with the party column and the "uploaded" mark. | The conformance suite covers them. |

From 0.9, users need Bun. Compiled binaries come when users ask for them.

## Phase 3: local parties with several vendors (0.10)

| Release | Delivers | Done when |
|---|---|---|
| 0.10.0 | The ACP runner. Codex workers in a local party, with the Claude Code session as the leader. Affinity. | Claude Code and Codex finish one request together on one machine. |
| 0.10.x | Cursor solo and the Gemini CLI, through the same ACP runner. | A Cursor chat leads a local party. |

## Phase 4: hosted (later)

| Step | Delivers | Done when |
|---|---|---|
| 1 | `meld serve`, hosted, with the Postgres store, HTTPS, logins, worker tokens, hosted parties with their queues, and the first cloud driver (a team's sandbox sessions). Merges with git plumbing on a bare clone. Delivery as a draft pull request. | One party with three sandbox sessions finishes one request as one pull request. |
| 2 | Share knowledge with a hosted party: the outbox, `grep_context` across both stores, and the share setting. | Solo runs feed a hosted party. |
| 3 | Join a hosted party: the API that members use to ask for work. | A local session and cloud agents finish one run of a party together. |
| 4 | Promote. The Cursor cloud and Devin drivers. | A local party moves to the hosted service, and cloud agents finish its runs. |

The model-based tests of the proposal (no task has two owners, a parent is done when its parts are done, and dependencies form no cycle) go into step 0a, so they cover every host. Parties add one more: no worker slot holds two tasks.

## Open choices

- In phase 4: share knowledge or join a party first. The proposal is share knowledge: it is small and safe, and every solo run starts to feed the team.
- The Devin token: a narrow token in the prompt with the risk accepted, or wait for secrets for each session.
- Path claims: warnings only, or refusals later.
- The open questions of [parties.md](parties.md).
