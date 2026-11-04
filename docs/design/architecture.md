# Architecture: one meld, many hosts

Status: draft. The rules below are proposals. The ports and `core/` are built on the branch `next` (step 0a of [plan.md](plan.md)).

## The rule

The meld core runs in every host. A host gives it adapters for storage, code, runners and screens. These rules hold in every host:

- A run lives in one store from start to end. Two stores do not sync a run.
- Every worker, local or cloud, calls the same MCP tools and gets the same replies.
- Each lane is a git ref. One merge engine, git plumbing on a bare repository, serves every host.

## Layers

```
            meld core: pure TypeScript, public, in this repository
  board rules · tool contract · Run shape and migrations · supervise() · merge · pane view model
                                     │
          ports: Store · CodeHost · Runner · Clock · Surface · Ledger
          ┌──────────────────────────┴──────────────────────────┐
  solo: meld mcp on your machine                  team: meld serve, hosted
  Store     SQLite                                Store     Postgres
  CodeHost  store.git and workspaces              CodeHost  bare mirror, same merge code
  Runner    Claude Code subagents, ACP            Runner    cloud drivers, local sessions that pull
  Clock     engine hooks, or its own loop         Clock     its own loop
  Surface   pane, commands                        Surface   web page
```

## The ports come from today's Io

meld 0.8 sends all I/O through one `Io` interface with 15 methods. The ports of `core/ports.ts` split it by job, and `Io` is now the sum of the ports:

| Port | `Io` methods | Solo adapter | Team adapter |
|---|---|---|---|
| Store | `read`, `write` | SQLite | Postgres |
| FactsStore | `readFacts`, `writeFacts` | session state | memory of the server |
| CodeHost | `run` (git, jj), `writeFile` (the jj config, the board mirror) | store.git | bare mirror |
| Runner | `spawn`, `send`, `agents` | subagents, ACP | drivers, sessions that pull |
| Clock | `now`, `sleep` | engine clock or system clock | system clock |
| Entropy | `random`, for the random characters of a run id | `crypto.getRandomValues` | `crypto.getRandomValues` |
| Surface | `toast`, `openPane`, `command` | pane | web page |
| Ledger | `cost` | session cost | usage from each driver |

With these ports, `core/actions.ts` (about 1000 lines that start, claim, restart, merge and deliver) runs in every host. Without them, the hosted service needs a second copy of that code.

Each function of the core takes only the ports that it uses, so the type check shows what each step needs. Step 0a found these needs:

- A board call of a worker needs the Runner as well as the Store: it sends nudges and wake texts to other agents. In `meld mcp`, those messages become rows of the table `actions`, and the leader carries them out (step 10b).
- Each write of the board needs the CodeHost, as it mirrors `board.json`. With SQLite in `~/.meld/`, the store outlives the session, and the mirror can go.
- Only the start needs every port: the Ledger for the cost at the start, and the Surface to open the pane.

Step 0b found these limits of the engine, in a live session:

- Each `$.mcp.call` of the plugin goes through the permission check of the engine. A `tool.check` hook of meld allows the calls of meld, and refuses the calls of the model and of other plugins.
- A timer callback runs outside every hook, so no hook of meld sees its calls, and the engine asks the person. The timer of the pane reads the copy of the run in the session state. The facts stay there too, as only the pane reads them.
- A hot reload of a mod loads its hooks again, but not its manifest. A server that a new manifest lists starts after `/reload-plugins`, or in a new session.

Step 0c adds the ports of a party in `core/party.ts`: `PartyRows` (the events and context entries of its runs, which are only added, and the outbox) and `Members` (the runners with their worker slots and a lease). They are not in `Io` yet, as no step of the core uses them. The ACP runner of 0.10 uses them.

Step 10c divides the restarts between two hosts. Each worker has one host that restarts it, so no worker gets two agents:

- The plugin restarts the Claude workers at the end of each turn of the main session.
- `meld mcp` restarts the ACP workers at the end of each prompt, and on a beat of 500 ms. A Claude worker can add work for an idle Codex worker while no prompt ends.
- `meld mcp` restarts the ACP workers of one board: the board that the plugin names with `lead_board`, at the start of the session and after a resume. It does so only while that session owns the board.
- A restart gives the worker a new agent, and the leader stops the old agent. A beat with nothing to do writes nothing.
- The plugin does the actions for the engine (messages to Claude workers, and toasts) at the end of each turn of the main session. `meld mcp` sends the messages to its ACP agents every 500 ms.

Before this rule, both hosts restarted ACP workers. Both could read the same idle Codex worker and start an agent for it, and the second binding won.

Step 10d adds affinity. An idle worker gets its old agent again while the context of that agent fills less than half of the window of its model (`AFFINITY_SHARE` in `core/board.ts`):

- Each model call of a Claude subagent gives its context: the whole input of the call, against the window of the model of the session. A worker on a model with a smaller window gets the larger window, so meld keeps its session too long.
- An ACP agent reports its context with `usage_update`, which gives `used` and `size`. An agent that reports none gets a fresh agent each time.
- The plugin resumes a Claude subagent with a message (`$.session.send`): a message to a subagent that ended its turn continues it from its transcript. meld mcp gives the prompt to the same ACP session.
- The agent list can show the turn before a resume as ended for a moment. So meld marks a resumed worker idle only after 15 s, or at its hand-back, which the tool guard sees.
- When a host cannot reach the old agent, the worker gets a fresh agent.

The pane needs one more channel: the workers of Codex write to the board through their own `meld mcp`, and no hook of the main session sees it. Step 10c built it:

- `meld mcp` answers `GET /boards/<id>` over HTTP on a Unix socket, `channels/<pid>.sock` next to the board file. Only the user of the process can open that folder.
- The tool `board_channel` names the socket. The plugin asks for it at the start of the session, in a hook.
- The timer of the pane reads the board there with `$.http.fetch`, which gets no permission check, and puts the run into the copy in the session state.
- The channel answers only reads. A socket path of more than 100 bytes gives no channel, and the pane then shows the copy, as in 0.9.

## Board addresses

A client sees a board address, not a store. A client is the Claude Code plugin, Cursor, or a cloud agent.

- A solo board is `meld mcp`: an MCP stdio process that Claude Code or Cursor starts and stops, like any MCP server. There is no daemon and no port.
- A team board is `meld serve`, hosted, over HTTPS.
- `meld mcp` and `meld serve` are one program with two entry points.
- Every board gives the same tools and the same replies.
- Laptops get no database credentials. Only the hosted service holds them.

In Claude Code, the plugin declares `meld mcp` as its MCP server. The engine API of Claude Code 2.1.317 gives the rest:

- A `tool.call` hook adds the worker id to each board call of a subagent, and refuses board calls from other agents.
- `$.mcp.call` calls a tool on a connected MCP server with the engine's own credentials. The pane reads the board this way, and the plugin forwards a call to a hosted board with the login of the user.

In Cursor, `.cursor/mcp.json` runs the same `meld mcp`. meld starts each worker through ACP, and gives each worker its own `meld mcp` process. All the processes on a machine open the same SQLite file, and one of them holds a lease as the supervisor.

## The supervisor

One function decides what each run needs: `supervise(run, now, observations)` returns actions such as "start w3" or "release #4". It works at two levels: the party (which member takes which task) and the run (merges, the final commit, delivery). See [parties.md](parties.md). Only the code that executes the actions differs:

- In Claude Code, the plugin starts subagents at the end of a turn. Only the engine can start them.
- In Cursor, the `meld mcp` process that holds the supervisor lease runs the loop, and starts workers through ACP.
- On a server, `meld serve` runs the loop, and starts workers through cloud APIs.
- A local session that is a member of a hosted party asks the service for its actions, and executes them in its own engine.

## Leases

A claim is a lease, and each observation of the worker renews it. When a lease expires, the supervisor releases the task, and the handover lets another worker continue. Leases use the time of the store, not the time of a laptop. Each worker has one source of liveness: several heartbeat stores give false "stuck" alarms.

The plugin restarts idle workers today, and the service would release stalled tasks. With leases, both are one rule.

## The merge engine

`mergeInGit` in `hooks/vcs.ts` merges a commit into the line with `merge-tree`, `commit-tree` and `update-ref`, in a bare git store. The git adapter and the jj adapter both call it, and the jj adapter then runs `jj git import`. The hosted service can call the same function on a bare mirror. A merge conflict adds an "integrate #N" task for a worker, so the service needs no jj and no agent to merge.

## The supervisor leader

The MCP endpoint needs no lock: each call does compare-and-set on its run. Only the supervisor loop needs one leader. A Postgres session advisory lock does not work behind a pooler in transaction mode, so the leader holds a lease row with an expiry.

## Path claims

A path claim is a guess, made before the work starts. Start with warnings: compare the real diffs at merge time, count the overlaps, and then decide on refusals. In solo mode, the shared SQLite file lets meld warn across sessions on one machine.
