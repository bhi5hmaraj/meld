# Build plan

Status: draft. Nothing here has started. meld 0.9.0 (SQLite storage) and 0.10.0 (flow metrics) are paused, and this plan includes both.

| Step | Delivers | Done when |
|---|---|---|
| 0a | The core moves out of the plugin. `Io` splits into the ports of [architecture.md](architecture.md). An in-memory store and the conformance suite. | All tests pass on the in-memory store, and the plugin works as in 0.8.0. |
| 0b | `meld serve` with the SQLite store. The Claude Code plugin becomes its client. The 0.8.0 board shape moves into SQLite rows. | A solo run works from start to delivery, and resumes in a new session. |
| 0c | Random characters in run ids. Events and context as rows that are only added. The "uploaded" mark. | The conformance suite covers them. |
| 1 | The hosted `meld serve` with the Postgres store, HTTPS, logins, worker tokens, and the first cloud driver (a team's sandbox sessions). Merges with git plumbing on a bare clone. Delivery as a draft pull request. | One request, three sandbox sessions, one pull request, measured from the event log. |
| 2 | Level 1, share knowledge: the outbox, `grep_context` across stores, and share settings for each project. | Solo runs feed the team store. |
| 3 | Level 2, join the swarm: the API that runners use to ask for work. | A local session and cloud agents finish one team run together. |
| 4 | Level 3, move a run. The Cursor cloud and Devin drivers. The ACP runner, which also gives Cursor solo. | A local run moves to the team and finishes there. |

The model-based tests of the proposal (no task has two owners, a parent is done when its parts are done, and dependencies form no cycle) go into step 0a, so they cover every host.

## Open choices

- The local runtime: Node with `node:sqlite`, or a Bun binary.
- After step 1: level 1 or level 2 first. The proposal is level 1: it is small and safe, and every solo run starts to feed the team.
- The Devin token: a narrow token in the prompt with the risk accepted, or wait for secrets for each session.
- Path claims: warnings only, or refusals later.
