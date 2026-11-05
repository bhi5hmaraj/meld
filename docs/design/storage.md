# Storage: SQLite for solo, Postgres for team

Status: the split, the store interface and Bun are agreed. The details are proposals.

## The split

- **Solo** keeps its board in a SQLite file on the machine.
- **Team** keeps its board in Postgres, behind the hosted service.

Every session that works on a run must reach the store of that run. All sessions on one machine reach a SQLite file. Sessions on several machines, or cloud threads in separate containers, reach only a hosted store.

## The store interface

Nothing above this interface knows the engine. `openStore` picks the adapter from the address:

```ts
interface Store {
  readParty(id: PartyId): Promise<Party | null>
  readyRuns(party: PartyId): Promise<RunSummary[]>
  readRun(id: RunId): Promise<VersionedRun | null>
  commitRun(change: RunChange): Promise<'committed' | 'stale'>
  addContextIfAbsent(entries: ContextEntry[]): Promise<void>
  searchContext(query: ContextQuery): Promise<ContextEntry[]>
  takeLease(lease: LeaseRequest): Promise<boolean>
}

openStore('sqlite:~/.meld/meld.db')
openStore(env.MELD_STORE_URL)
```

Search is the one part that differs: SQLite uses FTS5, and Postgres uses `pg_trgm`. `searchContext` hides the difference. Both adapters pass one conformance suite. CI runs it on SQLite in memory and on Postgres in a container.

## What the store holds

| Table | Rows | Rule |
|---|---|---|
| `parties` | one row per party: name, leader, host and policies | changed by the leader |
| `members` | the runners that staff a party: slots and repositories | each member holds a lease |
| `runs` | one row per run: its party, the Run JSON and a version | write with `UPDATE ... WHERE version = ?` |
| `events` | what happened: claims, merges, restarts, checks | rows are only added |
| `context` | what was learned, in the partition of a party: fact, fail, interface, done | rows are only added, except for changes of trust, retractions and hard deletes |
| `leases` | owners of runs, of claims and of worker slots | take and renew with compare-and-set |

**One row per run, not a task table.** The rules work on the whole Run: needs, parents and the version of the task list. A task table needs a mapping layer that drifts from the plugin. With a JSON row, the shape migrations of the plugin (the `run-4` shape today) also upgrade the rows of the service.

**Two logs.** meld 0.8.0 keeps an event log and the shared context in the Run, and trims both. The stores keep both complete. The event log feeds metrics, audit and run moves. The flow metrics planned for 0.10.0 become queries over the event log.

## Rules for two stores

1. **One owner per run.** A run lives in SQLite or in Postgres, not in both.
2. **Shared rows are only added.** Events and context entries go to another store with "insert if absent". A repeated upload does no harm.
3. **Ids that do not collide.** From 0.9, a run id is the start time in milliseconds in base 36, then four random base-36 characters. So two runs that start in the same millisecond get different ids, and the run id and the entry number make a key that is unique in every store.
4. **One schema.** Both stores hold the same Run JSON and the same rows.
5. **An outbox.** A context entry made in solo mode has an "uploaded" mark. It goes up when the user shares the local party with a hosted party.

## The board file as built in 0.9

One table holds the 0.8 board shape: `boards (id, run, version, owner, owner_at)`. Each session writes its run to its own board, with the Run JSON in `run`. The facts of the pane stay in the session state: the session reads them from the version control again. A commit names the version that it read, and stores the run only when the board is still at that version. A commit of another session while the owner wrote in the last 60 s is refused, and an adopt (a resume) moves the version, so a commit of the old owner from its last read is stale. A write whose change leaves the run as it was stores nothing: the version stays, so no reader sees a new write, and the lease of the owner runs from its last change. `PRAGMA user_version` holds the schema version: a meld that knows only an older one reads the file and writes nothing.

Step 0c adds four tables, and gives each board a party, `local` for now:

| Table | Rows | Rule |
|---|---|---|
| `parties` | one row for each party; a new file holds the party `local` | a local party has no leader |
| `members` | the runners that staff a party, with their worker slots | a member is live for 60 s after its last join |
| `events` | each log entry of each run, with the run id and the entry id as its key | only added: a row stays after the run trims its log |
| `context` | each context entry of each run, without its readers, with the mark `uploaded` | only added; the outbox is the entries with no mark |

Each commit of a board adds the new entries of its run in the same transaction, with "insert if absent", so the first write of an entry stays. The steps of `MIGRATIONS` bring an old file to the schema of the meld that opens it. They run in one transaction that takes the write lock, so two processes that open an old file migrate it once. `tests/party-conformance.ts` holds the rules of these rows and members, and the memory store and the SQLite store pass them. No step of the core reads them yet: the ACP runner of 0.10 adds its members, and the hosted phase uploads the outbox.

Step 10b adds the table `actions` (schema 3): the work that only the leader of a board can do, a message to an agent or a toast to the person. A worker of `meld mcp` writes these rows, and the leader takes each row once.

Schema 4 adds the table `runs`: a record of each run, for `/meld-clean`. A record holds the board of the run, its state, version control, repository, base and workers, and the time of its last change. Each write of a board updates the record of its run in the same transaction. A run that leaves its board keeps its record, and its board is null from then on. A value that the run lacks is null in its record, so the write of an odd run does not fail. Each board also records the time of its last change (`changed_at`). The migration makes a record of each run that a board holds, with the time of its last commit.

So with Bun, meld writes no `board.json`. Before, the core wrote the full board there after each write, so that the run outlived the session. Only a store that ends with the session keeps that file now: the session state, without Bun (`core/board-file.ts`). `/meld-clean` reads the record of a folder from `run_records`, and else from its `board.json`, which an older meld wrote.

At its start, `meld mcp` in the plugin mode and in the chat mode removes the rows that no step needs any more, in one transaction. A row goes when it is older than 30 days (`RETENTION_MS`):

| Rows | Go when |
|---|---|
| `boards` | the board holds no run or a delivered run, and changed more than 30 days ago |
| `runs` | no board holds the run, its record changed more than 30 days ago, and its folder under `/tmp/meld/` is gone, so `/meld-clean` has nothing to read |
| `events` | they are older than 30 days, and the file has no record of their run |
| `actions` | no leader took them in 30 days |
| `members` | the member was last seen more than 30 days ago |

The `context` rows stay: they are the knowledge that later runs read, and the outbox of the hosted phase. A stopped run stays on its board at any age, as its workspaces can hold work. SQLite does not make the file smaller after a removal: new rows use the free pages, so the file stops growing.

## Several sessions on one machine

- All runs live in `~/.meld/meld.db`, in WAL mode. Each editor session starts its own `meld mcp` process, and all the processes open the same file. There is no daemon.
- SQLite allows one writer at a time and many readers. Each board write is one short transaction: read the run, apply the rule, write with `WHERE version = ?`. A write that lost a race fails and tries again.
- The session that starts a run owns it, with a lease of about 60 s. Only the owner starts workers, delivers or discards.
- Other sessions see every run on the machine. A steer from another session goes into the run, and the owner applies it at its next check.
- When a session closes, its subagents stop and its lease expires. Another session can take the run (`/meld resume <run>`) and start fresh agents. The handovers on the board tell each new agent what the old one knew.
- Token counts arrive with each model call. The child batches them and writes every few seconds, so they do not hold the write lock.
- Run folders move from `/tmp/meld/` to `~/.meld/runs/`: a reboot clears `/tmp`, and a resume needs the commits.
- The file holds a schema version. A child older than the schema does not write, and tells the user to restart the session.
- Keep the file on a local disk. WAL does not work on network folders.
- Only its user reads the file, its write-ahead log and its shared memory (mode 0600), as the file holds the runs of every session. A new folder of the file is open to its user only (0700).
- Next to the file, the folder `channels` holds one Unix socket for each `meld mcp` of a session, where the pane reads its board. Only the user opens the folder, and each process removes the sockets of processes that ended.

## Why not Postgres for all

| | A Postgres server on each laptop | Only the hosted service |
|---|---|---|
| Install | Postgres on every laptop, with ports, users and upgrades | nothing local |
| Offline, or during an outage of the service | works | every run stops |
| Users with no team | a heavy install | cannot use meld |
| A board call | about 1 ms | a network round trip |
| SQL dialects | one | one |

A local Postgres is a server that each user must install and keep running. A SQLite file avoids that. "Only the hosted service" fits only a tool for one company. The cost of two dialects stays small with three or four tables, about ten queries, and one conformance suite.

PGlite (Postgres in WASM) gives one dialect, but only one process at a time can open its data folder, so two sessions cannot share it. SQLite is the better local choice.

## The runtime: Bun

Agreed: `meld mcp` and `meld serve` are one TypeScript program that runs on Bun. `bun:sqlite` gives SQLite, and `bun build --compile` makes one binary for each platform. The hooks module of Claude Code cannot run this code, so meld runs as a separate MCP process.

Node with `node:sqlite` was the other option. It is a release candidate since Node 25.7 ([pull request](https://github.com/nodejs/node/pull/61262)), but it gives no single binary.

Proposed distribution:

- First: both editors run a pinned npm version of meld with `bunx`. This needs Bun on the machine.
- Later: compiled binaries for each platform in the GitHub releases of meld, fetched once by a launcher that checks a pinned checksum. This needs nothing on the machine.

Today meld needs only git. Bun is the one new requirement.

## Dolt audit

Dolt is a SQL database with git operations: commits, branches, merges of single cells, diffs and queries on history. It pushes and pulls to DoltHub, S3, GCS or a git remote. Embedded Dolt is a Go library that needs cgo. Other languages talk to `dolt sql-server` over the MySQL protocol. Doltgres, the version with the Postgres protocol, is labeled beta.

| What meld needs | With Dolt | With SQLite or Postgres |
|---|---|---|
| A board for a Claude Code session (TypeScript, no Node in the module) | No option in the process: a Dolt server and a MySQL client in a helper | a child process with SQLite |
| Claims with one owner per run | works, but the versioning is not used | `UPDATE ... WHERE version = ?` |
| Write rate: meld writes on each tool call and each model call | a Dolt commit for each write makes a large history that needs garbage collection; commits must come only at milestones | no history to grow |
| Context shared across machines | push, pull and merge: a real fit | "insert if absent" with unique ids gives the same result |
| The board at a past time, and diffs | strong: queries on history | replay of the event log |
| Cloud workers | no effect: they call MCP | no effect |
| Operations | a new database to run, with garbage collection and health checks | SQLite needs nothing; Postgres is common |

Verdict (proposed): no Dolt for the board or for the service store. The main feature of Dolt merges data from many writers, which meld avoids by design: a run has one owner, and shared knowledge only grows, so it merges by union. One later fit is possible: a context store with no server, for users who share context through their own git remote (Dolt can push to a git remote under `refs/dolt/data`). That would be an optional adapter behind the store interface.

## TypeScript or Go

Proposal: stay in TypeScript.

1. The plugin must be TypeScript: the engine loads a TypeScript module with no native binary. So the rules exist in TypeScript in all cases, and a Go service would need a second copy of them.
2. The proposal plans the hosted service in TypeScript, so the core runs in the same process.
3. Speed does not limit meld. In the measured 0.7.0 runs, model time was 46 to 65% of worker time, and 142 board calls took about 0.1 s each, in runs of about 35 minutes.
4. The tools that chose Go did so for a CLI that agents start hundreds of times, one static binary for each machine, and embedded Dolt. None of these applies to meld.
5. Bun compiles the TypeScript into one binary for each platform, and includes SQLite.
