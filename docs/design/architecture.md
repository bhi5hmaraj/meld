# Architecture: one meld, many hosts

Status: draft. The rules below are proposals.

## The rule

The meld core runs in every host. A host gives it adapters for storage, code, runners and screens. These rules hold in every host:

- A run has one owner store at a time. A run can move to another store, but two stores do not sync one run.
- Every worker, local or cloud, calls the same MCP tools and gets the same replies.
- Each lane is a git ref. One merge engine, git plumbing on a bare repository, serves every host.

## Layers

```
            meld core: pure TypeScript, public, in this repository
  board rules · tool contract · Run shape and migrations · supervise() · merge · pane view model
                                     │
          ports: Store · CodeHost · Runner · Clock · Surface · Ledger
          ┌──────────────────────────┴──────────────────────────┐
  solo: meld serve on your machine                team: meld serve, hosted
  Store     SQLite                                Store     Postgres
  CodeHost  store.git and workspaces              CodeHost  bare mirror, same merge code
  Runner    Claude Code subagents, ACP            Runner    cloud drivers, local sessions that pull
  Clock     engine hooks, or its own loop         Clock     its own loop
  Surface   pane, commands                        Surface   web page
```

## The ports come from today's Io

meld 0.8.0 sends all I/O through one `Io` interface with 15 methods. The ports split it by job:

| Port | `Io` methods today | Solo adapter | Team adapter |
|---|---|---|---|
| Store | `read`, `write`, `readFacts`, `writeFacts`, `writeFile` | SQLite | Postgres |
| CodeHost | `run` (git, jj) | store.git | bare mirror |
| Runner | `spawn`, `send`, `agents` | subagents, ACP | drivers, sessions that pull |
| Clock | `now`, `sleep` | engine clock or system clock | system clock |
| Surface | `toast`, `openPane`, `command` | pane | web page |
| Ledger | `cost` | session cost | usage from each driver |

With these ports, `actions.ts` (934 lines that start, claim, restart, merge and deliver) runs in every host. Without them, the hosted service needs a second copy of that code.

## Board addresses

A client sees a board address, not a store. A client is the Claude Code plugin, Cursor, or a cloud agent.

- A solo board is a `meld serve` child process on the machine, on a Unix socket or stdio.
- A team board is the hosted `meld serve`, over HTTPS.
- Every board gives the same tools and the same replies.
- Laptops get no database credentials. Only the hosted service holds them.

The engine of Claude Code has the parts that this needs. They were checked in the engine API of Claude Code 2.1.317:

- `$.process.spawn` starts a child process that lives as long as the session.
- `$.http.fetch` accepts a `socketPath`, to reach a child on a Unix socket.
- `$.mcp.call` calls a tool on a connected MCP server with the engine's own credentials. The plugin can forward a call to a hosted board with the login of the user.

## The supervisor

One function decides what each run needs: `supervise(run, now, observations)` returns actions such as "start w3" or "release #4". Only the code that executes the actions differs:

- In Claude Code, the plugin starts subagents at the end of a turn. Only the engine can start them.
- In Cursor or on a server, `meld serve` runs its own loop and starts workers through ACP or cloud APIs.
- A local session on a team board asks the service for its actions, and executes them in its own engine.

## Leases

A claim is a lease, and each observation of the worker renews it. When a lease expires, the supervisor releases the task, and the handover lets another worker continue. Leases use the time of the store, not the time of a laptop. Each worker has one source of liveness: several heartbeat stores give false "stuck" alarms.

The plugin restarts idle workers today, and the service would release stalled tasks. With leases, both are one rule.

## The merge engine

`mergeInGit` in `hooks/vcs.ts` merges a commit into the line with `merge-tree`, `commit-tree` and `update-ref`, in a bare git store. The git adapter and the jj adapter both call it, and the jj adapter then runs `jj git import`. The hosted service can call the same function on a bare mirror. A merge conflict adds an "integrate #N" task for a worker, so the service needs no jj and no agent to merge.

## The supervisor leader

The MCP endpoint needs no lock: each call does compare-and-set on its run. Only the supervisor loop needs one leader. A Postgres session advisory lock does not work behind a pooler in transaction mode, so the leader holds a lease row with an expiry.

## Path claims

A path claim is a guess, made before the work starts. Start with warnings: compare the real diffs at merge time, count the overlaps, and then decide on refusals. In solo mode, the shared SQLite file lets meld warn across sessions on one machine.
