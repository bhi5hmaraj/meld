# Decision log

Status values:

- **Agreed:** the author agreed in the design discussion.
- **Proposed:** recommended, not confirmed.
- **Open:** a choice that is still to make.

| # | Decision | Status | Note |
|---|---|---|---|
| 1 | Two modes: solo with a SQLite board, team with a Postgres board. | Agreed | [storage](storage.md) |
| 2 | Nothing above the store interface knows the database engine. `openStore(url)` picks the adapter. | Agreed | [storage](storage.md) |
| 3 | Solo is one local pod, staffed by one Claude Code or Cursor session. Team is hosted pods, staffed by cloud agents and local sessions. | Agreed | [solo and team](solo-and-team.md) |
| 4 | A solo session can join a team in two ways: share knowledge with a hosted pod, or join a hosted pod as a member. | Agreed; the mechanics are proposed | [solo and team](solo-and-team.md) |
| 5 | One meld core runs in every host. Hosts differ only by adapters. | Proposed | [architecture](architecture.md) |
| 6 | A run lives in one store from start to end. Two stores do not sync a run. | Proposed | [architecture](architecture.md) |
| 7 | A client sees a board address, not a store. Laptops get no database credentials. | Proposed | [architecture](architecture.md) |
| 8 | Every worker uses the same MCP tools and gets the same replies, in every host. | Proposed | [architecture](architecture.md) |
| 9 | Lanes are git refs. One merge engine, git plumbing on a bare repository, serves every host. No jj on the service. | Proposed | [architecture](architecture.md) |
| 10 | One supervisor function decides, and the runners execute. Claims are leases. | Proposed | [architecture](architecture.md) |
| 11 | Runners pull work. The service does not start work on a laptop. | Proposed | [solo and team](solo-and-team.md) |
| 12 | A run is one row: its pod, the Run JSON and a version. No task table. | Proposed | [storage](storage.md) |
| 13 | Two logs, events and context, both complete in the store. | Proposed | [storage](storage.md) |
| 14 | Random characters in run ids. | Proposed | [storage](storage.md) |
| 15 | Postgres is the context store. Files are a read-only view. A search index can come later. | Proposed | [shared context](shared-context.md) |
| 16 | Keep `interface` as a context kind, and add `done`. | Proposed | [shared context](shared-context.md) |
| 17 | Runs send context entries on deliver, discard and stop. | Proposed | [shared context](shared-context.md) |
| 18 | Nothing leaves a laptop until the user shares the local pod with a hosted pod. | Proposed | [solo and team](solo-and-team.md) |
| 19 | Stay in TypeScript. No Go rewrite. | Proposed | [storage](storage.md) |
| 20 | No Dolt for the board or for the service store. | Proposed | [storage](storage.md) |
| 21 | The supervisor leader holds a lease row, not an advisory lock. | Proposed | [architecture](architecture.md) |
| 22 | The runtime is Bun: one TypeScript program with `bun:sqlite`, compiled with `bun build --compile`. | Agreed | [storage](storage.md) |
| 23 | Path claims: warnings first, refusals only if the data supports them. | Open | [architecture](architecture.md) |
| 24 | Build order after step 1: share knowledge before join a pod. | Open | [plan](plan.md) |
| 25 | The Devin token: a narrow token in the prompt, or wait for secrets for each session. | Open | [service review](service-review.md) |
| 26 | Solo uses one process, `meld mcp`: an MCP stdio server that Claude Code or Cursor starts and stops. No daemon and no port. | Agreed | [architecture](architecture.md) |
| 27 | No move of a run between stores. A team run starts on a hosted board. | Agreed | [solo and team](solo-and-team.md) |
| 28 | A pod is a group of workers that staff one queue and share one context partition. It can take tasks from any project. | Agreed | [pods](pods.md) |
| 29 | A run stays the unit of delivery. A pod is the unit of staffing and knowledge. Each run belongs to one pod. | Proposed | [pods](pods.md) |
| 30 | Workers belong to the pod and move between its runs. Each task gets a fresh agent. | Proposed | [pods](pods.md) |
| 31 | A pod cannot read the partition of another pod. Sharing across pods comes later, through a partition that an admin curates. | Proposed | [pods](pods.md) |
| 32 | Queue order: run priority, then the oldest ready task, with a cap of workers for each run. | Proposed | [pods](pods.md) |
| 33 | Distribution: a pinned npm version run with `bunx` first, compiled binaries with a checked checksum later. | Proposed | [storage](storage.md) |
