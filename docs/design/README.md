# meld design notes

Status: draft. These notes record the design of meld after 0.8.0: solo on a new local host, parties, and a hosted service. They give the options and the reasons for each choice. Some decisions are agreed and some are open. [decisions.md](decisions.md) gives the status of each one. 0.10.0 builds the local parts, and [plan.md](plan.md) gives the status of each step.

The notes start from a design proposal of November 2026 for a hosted meld service: one task queue and one shared context for coding agents from any vendor. The proposal was written against meld 0.7.0. [service-review.md](service-review.md) checks it against meld 0.8.0.

| Note | What it covers |
|---|---|
| [service-review.md](service-review.md) | The proposal, the parts that 0.8.0 made out of date, vendor checks, and risks |
| [architecture.md](architecture.md) | One meld core with many hosts: ports, board addresses, the supervisor, leases, the merge engine |
| [parties.md](parties.md) | Parties: groups of workers that staff one queue and share one context partition; the host model, promote and affinity |
| [storage.md](storage.md) | SQLite for solo and Postgres for team, the store interface, several sessions on one machine, Bun, a Dolt audit, TypeScript or Go |
| [solo-and-team.md](solo-and-team.md) | The two modes, the two ways a solo session joins a team, and the resources of each worker |
| [shared-context.md](shared-context.md) | Postgres as the store, files as a view, a search index as an option |
| [coordination-layer.md](coordination-layer.md) | meld as a coordination layer: what it owns, what it uses from other tools, a host on a VM, and the evaluation |
| [pane-metrics-logs.md](pane-metrics-logs.md) | A new pane, the system metrics (efficiency, progress, collaboration, use of the shared context, workload), and the logs |
| [prior-art.md](prior-art.md) | DeLM, beads, Gas Town and other tools: what they did, and what meld takes |
| [plan.md](plan.md) | The order of work, from solo releases to the hosted version |
| [decisions.md](decisions.md) | The decision log |

Words in these notes:

- **Run:** one request that several workers do together. A run is the unit of delivery: one integration line and one final commit.
- **Party:** a group of workers that staff one queue and share one context partition. A party can work on any project. Each run belongs to one party.
- **Leader:** the person who made a party. The leader invites, removes, sets policies, starts runs, steers and delivers.
- **Host:** the program that holds the board of a party: `meld mcp` on your machine, or `meld serve` on the hosted service.
- **Board:** the queues and the shared context, served as MCP tools by the host.
- **Worker:** an agent that claims tasks on the board.
- **Member:** a runner that staffs a party with a number of worker slots.
- **Lane:** the commits of one worker in one run.
- **Integration line:** the branch into which meld merges each finished task of a run.
- **Runner:** the part of a host that starts and stops workers: Claude Code subagents, an ACP process, or a cloud API.
- **Solo:** local parties in a SQLite file on your machine.
- **Team:** hosted parties in Postgres, staffed by cloud agents and local sessions.
