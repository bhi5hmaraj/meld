# meld design notes

Status: draft. These notes record the options for a hosted meld service and the reasons for each choice. Some decisions are agreed and some are open. [decisions.md](decisions.md) gives the status of each one. None of it is built.

The notes start from a design proposal of November 2026 for a hosted meld service: one task queue and one shared context for coding agents from any vendor. The proposal was written against meld 0.7.0. [service-review.md](service-review.md) checks it against meld 0.8.0.

| Note | What it covers |
|---|---|
| [service-review.md](service-review.md) | The proposal, the parts that 0.8.0 made out of date, vendor checks, and risks |
| [architecture.md](architecture.md) | One meld core with many hosts: ports, board addresses, the supervisor, leases, the merge engine |
| [storage.md](storage.md) | SQLite for solo and Postgres for team, the store interface, several sessions on one machine, a Dolt audit, TypeScript or Go |
| [solo-and-team.md](solo-and-team.md) | The two modes, and the three levels by which a solo session joins a team |
| [shared-context.md](shared-context.md) | Postgres as the store, files as a view, a search index as an option |
| [prior-art.md](prior-art.md) | DeLM, beads, Gas Town and other tools: what they did, and what meld takes |
| [plan.md](plan.md) | The build steps |
| [decisions.md](decisions.md) | The decision log |

Words in these notes:

- **Run:** one request that several workers do together.
- **Board:** the task queue and the shared context of a run, served as MCP tools.
- **Worker:** an agent that claims tasks on the board.
- **Lane:** the commits of one worker.
- **Integration line:** the branch into which meld merges each finished task.
- **Host:** a program that runs the meld core with adapters.
- **Runner:** the part of a host that starts and stops workers: Claude Code subagents, an ACP process, or a cloud API.
- **Solo:** one Claude Code or Cursor session on one project. The board is in SQLite on the machine.
- **Team:** cloud agents and local sessions on one hosted board. The board is in Postgres.
