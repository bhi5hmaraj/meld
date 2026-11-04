# Review of the hosted service proposal

Status: draft. Written on 4 November 2026, against meld 0.8.0 (main 7c725ff).

## The proposal in brief

The proposal moves the task queue and the shared context of meld into one TypeScript service, served over MCP. Workers from several vendors then work on one request: a team's own sandbox sessions, Cursor cloud agents, Devin sessions, and command-line agents through ACP. The shared context outlives each run, so later runs search what earlier runs learned, across projects.

The parts of the service:

- an MCP endpoint that checks a token for each worker
- the board rules of meld as a library (`board.ts`, `tasks.ts`, `progress.ts`)
- `grep_context`, a regex search over the shared context of one run, one project or all projects
- a git mirror: a read-only bare clone of each repository, to check the commits that workers name
- drivers that start and steer workers
- a supervisor loop: restarts, the release of stalled tasks, budgets, and CI polls
- three Postgres tables: runs, tasks and context
- path claims, which refuse two live runs on the same paths of one repository

The proposal keeps the local plugin as it is. A local run can only search and append to the shared context.

The proposal builds on DeLM ([paper](https://arxiv.org/abs/2606.10662), [project page](https://yuzhenmao.github.io/DeLM)). Its speed and accuracy figures come from the benchmark of the paper. They are not a forecast for meld.

## Parts that meld 0.8.0 made out of date

| The proposal says | meld 0.8.0 |
|---|---|
| Each board reply carries the 20 newest entries. | A reply carries only the entries that its reader has not seen. |
| One worker, the integrator, merges every lane at the end. "Integrate as tasks finish" is the largest gain. | Done. Each `finish_task` merges its own commit into an integration line, with no agent. A conflict adds an "integrate #N" task. Deliver refuses a final commit that misses a done task. |
| The service keeps one jj repository for each run and merges with `jj new`. | 0.8.0 merges with git plumbing (`merge-tree`, `commit-tree`, `update-ref`) in a bare git store, in jj mode and in git mode. The service can call the same function on a bare mirror, with no jj. |
| 10 to 33% of worker time waits for integration. | These numbers come from 0.7.0 runs, before the integration line. Measure again. |
| The pane shows 0 tokens. | Fixed: a hook counts the tokens of each model call. |
| Commands `/meld`, `/meld-steer`, `/meld-status` and `/meld-stop`; tools `start`, `steer` and `stop`; Deliver only in the pane. | Also `/meld-clean`, `/meld-deliver`, `/meld-discard` and `/meld-add`, and the tools `deliver`, `discard` and `add_worker`. |
| `finish_task` writes a DONE entry. | `finish_task` writes an interface entry and an "unfinished" fact. The summary stays on the task. There is no DONE kind. |
| Requirements: jj 0.40 for jj mode. | Also git 2.38 or newer, for `merge-tree --write-tree`. |

These parts are correct:

- 11 board tools, and versions with compare-and-set
- restarts at the end of the developer's turn, and no more restarts after 3 restarts in a row that finish no task
- 1 to 8 workers, one run for each session, and a pane that reads every 3 seconds
- all workers are Claude Code subagents, and each can be any agent type and model

Two 0.8.0 changes are not in the proposal:

- Each task gets a fresh agent. The claim reply carries the handovers of the tasks that it needs.
- A worker gets a prompt to split its task at 30, 60 or 120 tool calls (sizes S, M and L).

The integration line removes the main reason that the proposal gives for a service. Strong reasons remain: workers from several vendors, sandboxes in parallel, and memory across runs.

## Vendor checks (November 2026)

- **Cursor.** The Cloud Agents API (public beta) accepts inline `mcpServers` with headers or OAuth, and follow-ups with `delivery: "steer"`. A driver must follow three rules:
  - A steer accepts only `prompt` and `delivery`.
  - A follow-up that sends `mcpServers` replaces the board server for that run. Omit the field to keep it.
  - A follow-up with no `delivery` while a run is live gets `409 agent_busy`.

  Source: [Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints).
- **Devin.** An organization admin adds custom MCP servers (HTTP with headers), and all members share one entry. So a token for each worker cannot go in a header. The proposal puts the token in the prompt (see the risks). Source: [Devin MCP docs](https://docs.devin.ai/work-with-devin/mcp).
- **Codex cloud.** Support for custom MCP servers is not clear: there are forum reports and no official answer. Leave it out until that changes. Source: [OpenAI forum](https://community.openai.com/t/custom-mcp-server-in-codex-web/1378356).
- **ACP.** The registry lists Cursor, the Devin CLI and the Gemini CLI, and Claude through a wrapper. Source: [ACP registry](https://agentclientprotocol.com/registry).
- **MCP 2026-07-28.** This version removes the `initialize` handshake and the session id. That suits meld: identity comes with each request, and versions are arguments. Some vendor clients can use the older version, so test each client. Source: [Cloudflare on the new version](https://blog.cloudflare.com/mcp-v2/).

## The main problem: two boards

In the proposal, the plugin keeps its board in plugin storage, and the service keeps a second board in Postgres. They share only search and append. The results:

- two hosts of the rules, two supervisors, two stores and two merge paths, which will drift apart
- a local run cannot use a cloud worker, and a cloud run cannot use a local one
- a local run appends its entries at delivery, so a discarded run sends no FAIL entries, and those are the most useful entries

[architecture.md](architecture.md) gives the alternative: one core, many hosts.

## Risks

- **A token in the Devin prompt.** The token goes into the session logs and the UI of Devin, and the model can repeat it. Make it a narrow capability: one worker, one run, board tools only, an expiry at the end of the run, and a revoke on stop.
- **Sessions that a server starts on personal subscriptions.** A driver that starts sessions with the sign-in of a person uses that person's plan from a server. Check the plan terms before you depend on it. The pull model in [solo-and-team.md](solo-and-team.md) avoids this: the person's own session does the work.
- **Prompt injection that lasts.** Agents write the shared context, and other agents read it, across projects. One bad entry can reach later runs. Keep provenance on each entry (run, worker, commit, files, trust), search the worker's own project by default, and let admins retract entries.
- **Secrets in a log that only grows.** The secret filter will miss some secrets, and a correction entry does not remove them. The store needs a hard delete.
- **Scope.** Four drivers, a mirror, a supervisor, path claims and search make a large first release. Prove one driver first.
