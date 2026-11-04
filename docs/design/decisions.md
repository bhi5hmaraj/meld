# Decision log

Status values:

- **Agreed:** the author agreed in the design discussion.
- **Proposed:** recommended, not confirmed.
- **Open:** a choice that is still to make.

| # | Decision | Status | Note |
|---|---|---|---|
| 1 | Two modes: solo with a SQLite board, team with a Postgres board. | Agreed | [storage](storage.md) |
| 2 | Nothing above the store interface knows the database engine. `openStore(url)` picks the adapter. | Agreed | [storage](storage.md) |
| 3 | Solo is one Claude Code or Cursor session on one project. Team is cloud agents and local sessions on one hosted board, with a central context. | Agreed | [solo and team](solo-and-team.md) |
| 4 | A solo session can join a team later: share knowledge, join the swarm, or move a run. | Agreed; the mechanics are proposed | [solo and team](solo-and-team.md) |
| 5 | One meld core runs in every host. Hosts differ only by adapters. | Proposed | [architecture](architecture.md) |
| 6 | A run has one owner store at a time. A run can move, but two stores do not sync one run. | Proposed | [architecture](architecture.md) |
| 7 | A client sees a board address, not a store. Laptops get no database credentials. | Proposed | [architecture](architecture.md) |
| 8 | Every worker uses the same MCP tools and gets the same replies, in every host. | Proposed | [architecture](architecture.md) |
| 9 | Lanes are git refs. One merge engine, git plumbing on a bare repository, serves every host. No jj on the service. | Proposed | [architecture](architecture.md) |
| 10 | One supervisor function decides, and the runners execute. Claims are leases. | Proposed | [architecture](architecture.md) |
| 11 | Runners pull work. The service does not start work on a laptop. | Proposed | [solo and team](solo-and-team.md) |
| 12 | A run is one row: the Run JSON and a version. No task table. | Proposed | [storage](storage.md) |
| 13 | Two logs, events and context, both complete in the store. | Proposed | [storage](storage.md) |
| 14 | Random characters in run ids. | Proposed | [storage](storage.md) |
| 15 | Postgres is the context store. Files are a read-only view. A search index can come later. | Proposed | [shared context](shared-context.md) |
| 16 | Keep `interface` as a context kind, and add `done`. | Proposed | [shared context](shared-context.md) |
| 17 | Runs send context entries on deliver, discard and stop. | Proposed | [shared context](shared-context.md) |
| 18 | Nothing leaves a laptop until the user turns on sharing for a project. | Proposed | [solo and team](solo-and-team.md) |
| 19 | Stay in TypeScript. No Go rewrite. | Proposed | [storage](storage.md) |
| 20 | No Dolt for the board or for the service store. | Proposed | [storage](storage.md) |
| 21 | The supervisor leader holds a lease row, not an advisory lock. | Proposed | [architecture](architecture.md) |
| 22 | The local runtime: Node with `node:sqlite` first, a Bun binary later. | Open | [storage](storage.md) |
| 23 | Path claims: warnings first, refusals only if the data supports them. | Open | [architecture](architecture.md) |
| 24 | After step 1: share knowledge before join the swarm. | Open | [plan](plan.md) |
| 25 | The Devin token: a narrow token in the prompt, or wait for secrets for each session. | Open | [service review](service-review.md) |
