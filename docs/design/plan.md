# Build plan

Status: draft. Nothing here has started. meld 0.9.0 (SQLite storage) and 0.10.0 (flow metrics) are paused, and this plan includes both.

| Step | Delivers | Done when |
|---|---|---|
| 0a | The core moves out of the plugin. `Io` splits into the ports of [architecture.md](architecture.md). An in-memory store and the conformance suite. | All tests pass on the in-memory store, and the plugin works as in 0.8.0. |
| 0b | `meld mcp` on Bun, with the SQLite store and one local pod. The Claude Code plugin declares it as its MCP server and becomes its client. The 0.8.0 board shape moves into SQLite rows. | A solo run works from start to delivery, and resumes in a new session. |
| 0c | Random characters in run ids. Pods and members. Events and context as rows that are only added, with the pod column and the "uploaded" mark. | The conformance suite covers them. |
| 1 | `meld serve`, hosted, with the Postgres store, HTTPS, logins, worker tokens, hosted pods with their queues, and the first cloud driver (a team's sandbox sessions). Merges with git plumbing on a bare clone. Delivery as a draft pull request. | One pod with three sandbox sessions finishes one request as one pull request, measured from the event log. |
| 2 | Share knowledge with a hosted pod: the outbox, `grep_context` across both stores, and the share setting. | Solo runs feed a hosted pod. |
| 3 | Join a hosted pod: the API that members use to ask for work. | A local session and cloud agents finish one run of a pod together. |
| 4 | The Cursor cloud and Devin drivers. The ACP runner, which also gives Cursor solo. Compiled Bun binaries for each platform. | A pod with workers from three vendors finishes one request. |

The model-based tests of the proposal (no task has two owners, a parent is done when its parts are done, and dependencies form no cycle) go into step 0a, so they cover every host. Pods add one more: no worker slot holds two tasks.

## Open choices

- After step 1: share knowledge or join a pod first. The proposal is share knowledge: it is small and safe, and every solo run starts to feed the team.
- The Devin token: a narrow token in the prompt with the risk accepted, or wait for secrets for each session.
- Path claims: warnings only, or refusals later.
- The open questions of [pods.md](pods.md).
