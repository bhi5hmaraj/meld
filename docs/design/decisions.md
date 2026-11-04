# Decision log

Status values:

- **Agreed:** the author agreed in the design discussion.
- **Proposed:** recommended, not confirmed.
- **Open:** a choice that is still to make.

| # | Decision | Status | Note |
|---|---|---|---|
| 1 | Two modes: solo with a SQLite board, team with a Postgres board. | Agreed | [storage](storage.md) |
| 2 | Nothing above the store interface knows the database engine. `openStore(url)` picks the adapter. | Agreed | [storage](storage.md) |
| 3 | Solo is local parties on your machine, which start with one Claude Code or Cursor session. Team is hosted parties, staffed by cloud agents and local sessions. | Agreed | [solo and team](solo-and-team.md) |
| 4 | A solo session can join a team in two ways: share knowledge with a hosted party, or join a hosted party as a member. | Agreed; the mechanics are proposed | [solo and team](solo-and-team.md) |
| 5 | One meld core runs in every host. Hosts differ only by adapters. | Proposed | [architecture](architecture.md) |
| 6 | A run lives in one store from start to end. Two stores do not sync a run. | Proposed | [architecture](architecture.md) |
| 7 | A client sees a board address, not a store. Laptops get no database credentials. | Proposed | [architecture](architecture.md) |
| 8 | Every worker uses the same MCP tools and gets the same replies, in every host. | Proposed | [architecture](architecture.md) |
| 9 | Lanes are git refs. One merge engine, git plumbing on a bare repository, serves every host. No jj on the service. | Proposed | [architecture](architecture.md) |
| 10 | One supervisor function decides, and the runners execute. Claims are leases. | Proposed | [architecture](architecture.md) |
| 11 | Runners pull work. The service does not start work on a laptop. | Proposed | [solo and team](solo-and-team.md) |
| 12 | A run is one row: its party, the Run JSON and a version. No task table. | Proposed | [storage](storage.md) |
| 13 | Two logs, events and context, both complete in the store. | Proposed | [storage](storage.md) |
| 14 | Random characters in run ids. | Proposed | [storage](storage.md) |
| 15 | Postgres is the context store. Files are a read-only view. A search index can come later. | Proposed | [shared context](shared-context.md) |
| 16 | Keep `interface` as a context kind, and add `done`. | Proposed | [shared context](shared-context.md) |
| 17 | Runs send context entries on deliver, discard and stop. | Proposed | [shared context](shared-context.md) |
| 18 | Nothing leaves a laptop until the user shares a local party with a hosted party. | Proposed | [solo and team](solo-and-team.md) |
| 19 | Stay in TypeScript. No Go rewrite. | Proposed | [storage](storage.md) |
| 20 | No Dolt for the board or for the service store. | Proposed | [storage](storage.md) |
| 21 | The supervisor leader holds a lease row, not an advisory lock. | Proposed | [architecture](architecture.md) |
| 22 | The runtime is Bun: one TypeScript program with `bun:sqlite`, compiled with `bun build --compile`. | Agreed | [storage](storage.md) |
| 23 | Path claims: warnings first, refusals only if the data supports them. | Open | [architecture](architecture.md) |
| 24 | Build order in the hosted phase: share knowledge before join a party. | Open | [plan](plan.md) |
| 25 | The Devin token: a narrow token in the prompt, or wait for secrets for each session. | Open | [service review](service-review.md) |
| 26 | Solo uses one process, `meld mcp`: an MCP stdio server that Claude Code or Cursor starts and stops. No daemon and no port. | Agreed | [architecture](architecture.md) |
| 27 | A run does not move between stores by itself. A whole local party can move once to the hosted service, during a pause (promote). | Agreed | [parties](parties.md) |
| 28 | A party is a group of workers that staff one queue and share one context partition. It can take tasks from any project. The name is "party". | Agreed | [parties](parties.md) |
| 29 | A run stays the unit of delivery. A party is the unit of staffing and knowledge. Each run belongs to one party. | Proposed | [parties](parties.md) |
| 30 | Workers belong to the party and move between its runs. | Proposed | [parties](parties.md) |
| 31 | Search covers the party first, then related parties, ranked lower. Related parties share a repository or have a link from the leader. A leader can mark a party private. | Agreed | [parties](parties.md) |
| 32 | Queue order: affinity, then run priority, then the oldest ready task, with a cap of workers for each run. | Proposed | [parties](parties.md) |
| 33 | Distribution: a pinned npm version run with `bunx` first, compiled binaries with a checked checksum later. | Proposed | [storage](storage.md) |
| 34 | Each party has a leader (a person) and a host (your machine or the hosted service). Members join with an invite code. | Agreed | [parties](parties.md) |
| 35 | Members from other machines and cloud agents join hosted parties only, at first. A laptop host through a relay can come later. | Agreed | [parties](parties.md) |
| 36 | Affinity: a related task goes to the worker that did the earlier task, and meld continues its agent session. A switch or a full context starts a fresh agent with the handover. | Agreed | [parties](parties.md) |
| 37 | A worker uses the resources of the place where it runs. A party shares only the board and the git remote. | Proposed | [solo and team](solo-and-team.md) |
| 38 | Each local worker gets its own port range, database and browser profile. Local workers share one package cache. | Proposed | [solo and team](solo-and-team.md) |
| 39 | Each check records where it ran. The final checks run in one reference environment: the integrator, then CI. | Proposed | [solo and team](solo-and-team.md) |
| 40 | Order of work: solo first and to users, then local parties with Claude Code and Codex, then the hosted version. | Agreed | [plan](plan.md) |
| 41 | In 0.9, `meld mcp` is the store of the Claude Code plugin: the plugin keeps the logic in `core/`, and commits the run with compare-and-set through the tools of `meld mcp`. Without Bun, the plugin keeps the run in the session state, as 0.8 does. The board tools move into `meld mcp` in 0.10, for the workers of Codex and other vendors, with the same `core/`. | Proposed | [plan](plan.md) |
