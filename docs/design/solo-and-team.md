# Solo and team

Status: draft. The two modes, the two ways to join a team, and promote are agreed. The mechanics are proposals.

## The two modes

- **Solo:** local parties in a SQLite file on your machine. A solo party starts with one Claude Code or Cursor session, and meld can add Codex workers to it.
- **Team:** hosted parties in Postgres, staffed by cloud agents and local sessions. Each party has a central context partition.

[parties.md](parties.md) describes parties.

| | Solo | Team |
|---|---|---|
| Board | `meld mcp` on your machine | `meld serve`, hosted |
| Store | SQLite file | Postgres |
| Clients | the Claude Code plugin, Cursor, and the CLI workers that meld starts | your session, sandbox sessions, Cursor cloud agents, Devin |
| Connection | MCP over stdio | MCP over HTTPS, with your login or a worker token |
| What starts workers | the Claude Code engine, or ACP | cloud drivers, and your session as a member |

## Solo in Claude Code

The plugin declares `meld mcp` as its MCP server, and Claude Code starts and stops it with the session. The plugin starts the subagents, draws the pane, guards edits, and adds the worker id to each board call of a subagent. At each turn end, it asks the board which workers to start.

## Solo in Cursor

There is no plugin. `.cursor/mcp.json` runs the same `meld mcp`. meld then starts the workers itself as Cursor CLI processes through ACP, each in its own worktree and each with its own `meld mcp` process. All the processes open the same SQLite file. The process that holds the supervisor lease runs the supervisor loop, the same loop that the hosted service runs. The Cursor chat controls the run with the session tools (start, steer, status). This path needs the ACP runner.

## Codex in a local party

meld starts each Codex worker through ACP. Each Codex worker gets its own worktree and its own `meld mcp` process on the same SQLite file. The Claude Code session stays the leader. This path needs the same ACP runner as Cursor.

## Team

- Each run lives in Postgres, in a hosted party.
- Cloud agents (sandbox sessions, Cursor cloud agents, Devin) staff a party through drivers. Each gets its own worker token.
- Your session can staff a party as a member. The service cannot start work on your laptop, so your plugin asks for work at each check, and the service gives it the next task in the queue of the party, with a lease.
- Your subagents claim tasks on the hosted board. The plugin forwards each call over HTTPS with your login and the worker id.
- Each lane goes to `refs/meld/<run>/<worker>` on the shared git remote. The service merges each lane into the integration line of its run.
- Your subscription pays for your subagents, and the service does not hold your credentials.

## A solo session joins a team: two ways

The two stores do not talk to each other. Each run lives in one store from start to end. Your session knows two board addresses, and sends each call to the board that owns the run. Only two things cross between your laptop and the service, and neither is a sync.

```
 your laptop                                hosted service
┌─────────────────────────────────┐         ┌───────────────────────┐
│ Claude Code session             │         │ meld serve + Postgres │
│                                 │ entries │                       │
│ solo run ─► meld mcp (SQLite)   ├────────►│ party context         │
│                                 │ one way │                       │
│ team run ───────────────────────┼────────►│ party queue and runs  │◄── cloud agents
│                                 │  board  │                       │
└─────────────────────────────────┘  calls  └───────────────────────┘
```

### 1. Share knowledge with a hosted party

- Each context entry in SQLite has an "uploaded" mark. When you share your local party with a hosted party, `meld mcp` sends new entries with "insert if absent". A repeated upload does no harm, and time offline only delays the upload.
- `grep_context` searches your SQLite first, then the hosted party.
- You choose what to share: nothing (the default), delivered runs only, or all runs. The secret filter runs before each upload.
- The service records who sent each entry. The run and the commit come from your laptop, and the service cannot check them, so these entries get a lower trust value than entries written on the hosted board.
- An entry can name a commit that exists only on your laptop. Search still works, but the check for stale entries needs that commit on the shared remote.

### 2. Join a hosted party

- `/meld-party join <code> --slots 3` registers your session as a member. It sends your login, the repositories on your machine, the agent type and the number of slots.
- Your session gets the whole party context, and only tasks in repositories that you have and can push to.
- `/meld-party leave` stops new tasks. Current tasks finish or hand back.
- If your laptop closes, your lease expires and the service releases the task. The handover lets another worker continue it.
- SQLite takes no part in this: your session is one more worker on the hosted board.

## A local party that needs cloud agents: promote

A run does not move by itself. A whole local party can move once to the hosted service, during a pause, with `/meld-party promote`. [parties.md](parties.md) gives the steps. If you know at the start that cloud agents will join, create the party on the hosted service.

## Resources

A worker uses the resources of the place where it runs. The party shares only two things: the board (the queue and the context) and the git remote (the lanes and the integration lines).

| | Local workers | Cloud agents | The host |
|---|---|---|---|
| Compute | your laptop | the VM or sandbox of the vendor, one per agent | the hosted service or your laptop |
| Workspace | one worktree or jj workspace each, on one shared object store | its own clone | a bare mirror |
| Build and test | your toolchain | the environment of the vendor, from a setup script or an image | none: merges use git plumbing and need no build |
| Setup time | low, with warm workspaces and a shared package cache | a clone and an install on each new VM, unless the vendor keeps a prepared image | none |
| Cost | your subscription and your machine | the bill of the vendor | small |

Local workers share one machine, so they can collide:

- **Ports:** two dev servers can try to use the same port. Give each worker its own port range.
- **Databases:** two test runs can use one local database. Give each worker its own database or schema.
- **Browsers:** in the measured runs, one worker drove the browser tab of another worker. Give each worker its own browser profile.
- **Caches:** share these. One package store cuts the install time of each workspace.

Cloud agents do not collide with each other, but their environments can differ from yours. So each check on the board records where it ran (the OS and the tool versions), and the final checks run in one reference environment: the workspace of the integrator, then CI on the pull request.

## Edge cases

- Leases use the time of the store, not the time of the laptop.
- Each forwarded call carries a request id, so a retry does not apply twice.
- A finish after its lease expired: accept it only if nobody claimed the task since (compare-and-set on the task version). Else keep the commit on its lane and log it, so no work is lost.
- The service checks that the commit of a lane exists on the shared remote before it accepts `finish_task`.
