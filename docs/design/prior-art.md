# Prior art

Status: notes from November 2026.

## DeLM

meld runs the design of DeLM: a task queue and a shared context, with no planner in charge ([paper](https://arxiv.org/abs/2606.10662)).

## beads

beads is an issue tracker for coding agents, written in Go. Its storage history, from its changelog and its code:

- Until February 2026: a daemon for each repository, a SQLite store, and a JSONL file in git with automatic sync.
- v0.51 (February 2026): a "massive 8-phase refactoring" removed the daemon, the JSONL sync, the 3-way merge engine and SQLite. Dolt became the only store.
- v0.56: a separate Dolt server became mandatory. The changelog says that versions 0.55 to 0.63 had "critical reliability issues". DoltHub wrote that the move "added friction for solo Beads users" ([post](https://www.dolthub.com/blog/2026-04-02-restoring-beads-classic/)).
- v1.0 (April 2026): Dolt inside the process (embedded) became the default. The server is for setups with many writers.
- v1.2.1 (August 2026): a storage interface with a SQLite adapter and a conformance harness. Postgres and MySQL adapters were rolled back before a release, "to keep Beads simple and resource-light".
- v1.3.4 (November 2026): the SQLite backend is rolled back too, "to consolidate storage on a single engine and dialect". Dolt is the only store.
- Size: about 470,000 lines of Go, without tests.

What meld takes:

| beads | meld |
|---|---|
| The daemon that synced two stores caused bugs, and they deleted it | No sync daemon: one owner per run, and uploads that only add rows |
| A mandatory server hurt solo users | Solo needs no server that the user runs |
| A storage interface with optional capabilities, and one conformance suite across backends | The same: two adapters, one suite |
| Two engines and two dialects were too many for them | The risk of the SQLite and Postgres split: keep the SQL small, and test it on both |
| Compare-and-set on claims, after races in scripts that read a status and then wrote it | Claims, releases and hand-overs stay compare-and-set |
| Claims carry a lease expiry and a heartbeat time | Leases on claims |
| A proposed provenance log: rows only added, typed kinds (claim, handoff, commit, land), event time and ingest time, and ids from the content, so that a repeat does nothing | The same shape for the event log of meld |
| Hash ids need no coordination between writers | Random characters in run ids |
| Short-lived execution traces stay out of shared history | Transcripts and token counts stay with the run; only context entries go up |

## Gas Town

Gas Town is a multi-agent workspace on beads. Its notes:

- It runs one Dolt server for a whole workspace. Its daemon checks the server every 30 s and restarts it. A helper writes JSONL backups every 15 minutes, and a guide covers Dolt hangs.
- It adds an agent CLI by configuration, in tiers: none, a preset, hooks, and a deep integration.
- Its worker API design says "push, not scrape". It lists more than 28 fragile points of integration: keystrokes into tmux, regexes on prompts, and transcript files.
- It had three heartbeat stores, and they gave false "stuck agent" alarms.
- A proposal keeps the control plane apart from the work plane: workers in cloud containers call back to the control plane.
- New workers start from an integration branch, so they get the work of their siblings.
- Agents do the supervision and the merge queue (the Witness, Deacon and Refinery roles).

What meld takes:

- one lifecycle schema for all runners: started, ready, busy, idle, stopped, usage
- one source of liveness for each worker
- the board apart from the workspaces
- runners added by configuration, for the ACP runner
- each new task starts from the integration line (meld does this for an added worker today)

What meld does not take: agents for supervision and merging. meld does both with code, and uses an agent only for a merge conflict and the final build. Code costs no tokens and behaves the same each time.

## Codecast

Codecast is an open-source team workspace for agent sessions ([repository](https://github.com/codecast-sh/codecast)). Its notes, at commit `fc0f0d8`:

- A daemon starts Claude Code, Codex, Cursor, OpenCode, pi and Grok in tmux panes. It types messages into the pane and reads the transcripts from disk.
- It uploads each shared transcript. Before the upload, it removes secrets by shape and by the exact values that it finds on the machine.
- Its plan loop starts one headless agent for each ready task, every 2 minutes, in one shared checkout. The prompt of a plan agent holds the titles of done tasks, not their summaries.
- Its message policy sends facts up to a lead, which reads its whole area. A simulation with up to ten workers measured it against free messages between peers ([agent-comms.md](https://github.com/codecast-sh/codecast/blob/fc0f0d8c2340edbbdb9708d9a8eacf22aaa1d67b/docs/architecture/agent-comms.md)).

What meld takes:

- its session search as the history across runs (see [coordination-layer.md](coordination-layer.md))
- its daemon on a shared host, as the place where people watch the workers of meld
- its simulation of messages, as the first test of the shared log
- markers in the result of a worker (blocked, needs context, done with concerns)

## Amp

Amp is a hosted coding agent ([manual](https://ampcode.com/manual)). Its notes:

- A workspace is a team space. Threads are visible to the whole team by default, and members search them and pass them to an agent as context.
- An orb is a cloud machine for each thread, with the repository, the tools and the setup scripts of the project. It sleeps when idle and costs nothing then.
- An agent can start other agents and send them files. Information moves between agents only in messages and files.
- An assistant (Puck) splits a request across agents and collects their reports. There is no task queue.

What meld takes: the orb as the model of a sandbox for each worker or trial: setup scripts, secrets, sleep and wake, and a limit on how many start at once.

## Others

- **Claude Code agent teams** (experimental) keep the shared task list as JSON files with a file lock: no database and no server. This comes from a third-party analysis ([write-up](https://dev.to/nwyin/reverse-engineering-claude-code-agent-teams-architecture-and-protocol-o49)), not from official documents.
- **MCP Agent Mail** keeps messages in git and indexes them in SQLite. Its file reservations are advisory leases that expire: the path-claim model of [architecture.md](architecture.md) ([listing](https://glama.ai/mcp/servers/@Dicklesworthstone/mcp_agent_mail)).

Sources for beads and Gas Town: the [beads changelog](https://github.com/steveyegge/beads/blob/main/CHANGELOG.md), its [storage proposal](https://github.com/steveyegge/beads/blob/main/PROPOSAL-pluggable-storage-backends.md), its [provenance ADR](https://github.com/steveyegge/beads/blob/main/engdocs/adr/0003-provenance-event-log.md), and the [Gas Town docs](https://github.com/steveyegge/gastown/tree/main/docs).
