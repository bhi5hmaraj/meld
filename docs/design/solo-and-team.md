# Solo and team

Status: draft. The two modes are agreed. The mechanics are proposals.

## The two modes

- **Solo:** one Claude Code or Cursor session works on one project. The board is in SQLite on the machine.
- **Team:** cloud agents and local sessions work on one hosted board. The board is in Postgres, and the shared context is central.

| | Solo | Team |
|---|---|---|
| Board | `meld serve` child process on your machine | hosted `meld serve` |
| Store | SQLite file | Postgres |
| Clients | the Claude Code plugin, or Cursor | your session, sandbox sessions, Cursor cloud agents, Devin |
| Connection | Unix socket (Claude Code) or stdio (Cursor) | HTTPS, with your login or a worker token |
| What starts workers | the Claude Code engine, or ACP | cloud drivers, and your session as a runner |

## Solo in Claude Code

The plugin starts the `meld serve` child, starts the subagents and draws the pane. At each turn end, it asks the child which workers to start. It adds the worker id to each board call of a subagent.

## Solo in Cursor

There is no plugin. Cursor connects to the same `meld serve` through its MCP configuration. `meld serve` then starts the workers itself as Cursor CLI processes through ACP, each in its own worktree. It also runs the supervisor loop, the same loop that the hosted service runs. The Cursor chat controls the run with the session tools (start, steer, status). This path needs the ACP runner.

## Team

- The run lives in Postgres on the hosted board.
- Cloud agents (sandbox sessions, Cursor cloud agents, Devin) join through drivers. Each gets its own worker token.
- Your session joins as a runner. The service cannot start work on your laptop, so your plugin asks for work at each check. The service then reserves a worker slot on a team run for your session, with a lease.
- Your subagents claim tasks on the team board. The plugin forwards each call over HTTPS with your login and the worker id.
- Each lane goes to `refs/meld/<run>/<worker>` on the shared git remote. The service merges each lane into the integration line of the run.
- Your subscription pays for your subagents, and the service does not hold your credentials.

## A solo session joins a team: three levels

Each level is optional. A session can use all three at the same time: local runs on SQLite, and team runs on the hosted board. The plugin sends each call to the board that owns its run.

### 1. Share knowledge

- Each context entry in SQLite has an "uploaded" mark. When you turn on sharing for a project, the child uploads new entries with "insert if absent", so a repeated upload does no harm.
- `grep_context` searches your SQLite first, then the team store.
- For each project, you choose what to share: nothing (the default), delivered runs only, or all runs. The secret filter runs before each upload.

### 2. Join the swarm

- `/meld-team join <project> --slots 3` registers your session as a runner. It sends your login, the repositories on your machine, the agent type and the number of slots.
- The service gives you only tasks in repositories that you have and can push to.
- `/meld-team leave` stops new tasks. Current tasks finish or hand back.
- If your laptop closes, your lease expires and the service releases the task. The handover lets another worker continue it.

### 3. Move a local run to the team

- `/meld-team move <run>` pushes the lanes and the integration line to the shared remote. It uploads the run with its events and context, and makes the hosted board the owner.
- The local row keeps a pointer to the hosted run. Your session stays a runner of the run, and cloud agents can join it.
- This step needs random characters in run ids, so that two laptops cannot make the same id.

## Edge cases

- Leases use the time of the store, not the time of the laptop.
- Each forwarded call carries a request id, so a retry does not apply twice.
- A finish after its lease expired: accept it only if nobody claimed the task since (compare-and-set on the task version). Else keep the commit on its lane and log it, so no work is lost.
- The service checks that the commit of a lane exists on the shared remote before it accepts `finish_task`.
