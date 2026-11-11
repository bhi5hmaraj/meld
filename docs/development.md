# Development

```
claude plugin validate .
claude plugin test .
bun test mcp/
tsc -p tsconfig.core.json
node scripts/adapters.mjs
node scripts/shots.mjs
```

## The code

`core/` holds the code that needs no Claude Code, so another host can run it: `meld mcp` from 0.9. `hooks/` holds the Claude Code host. `tsc -p tsconfig.core.json` checks `core/` and `types/` with no engine types.

- `core/ports.ts` holds the ports that a host gives the core. They are `Store` (the run of the session), `FactsStore` (what the pane shows of the run), `CodeHost` (commands and files), `Runner` (agents), `Clock`, `Surface` (toasts, the pane, commands), `Ledger` (the cost) and `Archive` (the folder of the run records). A function takes only the ports that it uses. `Io` is all of them.
- `core/board.ts` holds the board rules as pure functions, `core/tasks.ts` the task tree, and `core/progress.ts` the percent.
- `core/actions.ts` holds the steps of a run, and the verdicts on the tool calls of agents.
- `core/view.ts` holds the items of the board with their refs: the short board reply, the read by ref, and the texts of the board files.
- `core/vcs.ts` holds the version control port and its two adapters, jj and git, and `core/git.ts` the git commands.
- `core/contract.ts` holds the tools, the rules and the prompts of the agents.
- `core/options.ts` reads the options of `/meld`.
- `core/clean.ts` lists and removes the folders of other runs for `/meld-clean`.
- `core/memory-store.ts` is a `Store` and a `FactsStore` in memory, and `core/remote-store.ts` a `Store` over a board server that compares versions.
- `core/party.ts` holds the ports of a party: its rows that are only added (the events and context entries of its runs) and its members. `core/memory-party.ts` keeps them in memory.
- `core/resume.ts` lists and takes the runs of other sessions for `/meld-resume`.
- `mcp/` holds `meld mcp`, which runs on Bun. `main.ts` starts it, `protocol.ts` speaks MCP over standard input and output with no other package, `tools.ts` holds its tools, and `sqlite-store.ts` keeps the boards. Its specs are `*.spec.ts` files, which `bun test mcp/` runs. The engine runner loads only `*.test.ts` files, and those cannot import `bun:sqlite`.
- `mcp/acp.ts` is the ACP client that starts the agents of other vendors, such as Codex, over the JSON-RPC link of `mcp/json-rpc.ts`. Its spec runs against a stub ACP agent.
- `mcp/worker.ts` is the worker mode, `meld mcp --worker`: the board tools of one ACP worker, with the commands of `mcp/code-host.ts`. A message of a worker to another agent becomes an action for the leader.
- `mcp/leader.ts` is the ACP runner of the leader. For each ACP worker, `meld mcp` starts an ACP agent with its own `meld mcp --worker`, sends its prompts, and starts the idle ACP workers again at the end of each prompt. `mcp/io.ts` gives the ports of the core in `meld mcp`.
- `mcp/chat.ts` is the chat mode, `meld mcp --chat`: the tools of the main session for an MCP client such as Cursor. `mcp/agents.ts` reads the ACP agents of `MELD_ACP_AGENTS`.
- `mcp/mirror.ts` writes the board files, one folder for each version behind a link. The leader calls it on its beat.
- `mcp/channel.ts` answers the reads of boards on a Unix socket. The plugin reads its board there too. The timer of the pane reads its board there, as a timer cannot call `meld mcp`.
- `mcp/backup.ts` makes the daily copy of the board file.
- `hooks/board-store.ts` connects the hooks to `meld mcp`.
- `hooks/pane.tsx` and `hooks/drawing.ts` draw the pane.
- `hooks/register.tsx` is the one file that calls the engine.

## The hooks

A hooks module spells `$` at its call sites and does not give it to other functions, so each hook builds its own `Io`. An agent that a hook starts runs under that hook and skips it. For this reason, meld has three `tool.call` hooks: the start, steer and stop tools, the board tools, and the guard of every other tool.

An agent that a timer or a button closure starts skips every hook of meld. For this reason, a `ui.press` and a `ui.input` hook serve the buttons and fields that start agents. The restarts come from hooks of the main session. The guard lets each `SubagentHandback` through, because that call ends the run of an agent.

A `turn.step` hook adds the cost of each model call to the agent that made it. A `session.compact` hook tells the summary of a compacting agent what to keep. Three `tool.check` hooks give the verdicts of [docs/how-it-works.md](how-it-works.md#permission-checks).

## The tests

The tests use a fake `Io` over the memory store, and mount the pane on each surface. A test holds each block of the pane to 100 words at most. `tests/store-conformance.ts` holds the checks that each `Store` must pass, and `tests/memory-store.test.ts` runs them on the memory store. The SQLite store of 0.9 runs the same checks. `tests/party-conformance.ts` does the same for the rows and members of a party.

`tests/model.test.ts` plays 200 seeds of random board calls by three workers, stopped workers too. After each call, it checks the rules:

- one owner for each claimed task
- no claim of a task with parts, or of a task that waits
- a parent done exactly when its parts are done
- no loop of needs
- a new version for each change of a task

A broken rule names its seed and the calls before it.

## The scripts

`scripts/adapters.mjs` checks the jj and git adapters with real processes. It compiles `core/` with `tsc` into a temporary folder. For each adapter, a temporary git repository goes through a run:

- three workspaces, and a commit in each
- the integration line: a move forward, two merge commits, a commit that the line holds, and a conflict
- the integration, and the commits that the final commit lacks
- the lanes, with an edit that no jj command recorded
- the work that a plain read hides: new files with `status.showUntrackedFiles=no`, and a new file that jj does not record
- the result, deliver, two new workspaces (one from the line, one from the base), the move of the line to the final commit, and remove

A second run of one worker checks three more cases: a commit on a detached `HEAD`, an edit that `jj new` left behind, and removals through a folder that an agent made a link. HOME is a temporary folder, so the check does not read or change your git or jj config. The script prints PASS or FAIL for each step, and it exits with code 1 when a step fails. It needs `tsc` 5.6 or newer, git, and jj 0.40 or newer.

`scripts/shots.mjs` draws the pictures of the README. `scripts/scenes.tsx` builds sample runs with the board functions and prints the tree that the pane draws for each run. The script makes an HTML page of each tree, and takes a picture in a light and a dark theme with Playwright. The lanes, the bars and the texts are the ones that meld draws. The fonts and the spacing stand in for the app.
