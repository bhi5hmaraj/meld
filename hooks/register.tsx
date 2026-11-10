import { atom, read, update } from 'claude-code'
import type { AgentStatus, HookFailure, Register } from 'claude-code'

import { compactWorker, controlRun, countStep, guardCall, markWorker, refreshFacts, restartIdleWorkers, serveTool, spawnVerdict, startFromView, startRun, steerRun, stopAll, vcsVerdict } from '../core/actions'
import { CONTEXT_CAP } from '../core/board'
import { cleanFolders } from '../core/clean'
import type { Action, BoardRead, Boards, BoardSummary, Committed } from '../core/remote-store'
import { resumeRun } from '../core/resume'
import { BOARD_TOOLS, COMMAND_CONTROLS, SESSION_TOOLS, STEER_PRESETS, TOOL, TOOL_PREFIX, TOOL_SPECS, WORKER_SYSTEM } from '../core/contract'
import type { AgentState, FactsStore, Files, Io, RunRecord, RunRecords, Spawned, Store } from '../core/ports'
import { parseStart, WORKER_TYPE } from '../core/options'
import { adoptedOf, BOARD_STORE_TOOLS, boardVerdict, copyFromChannel, noBoardWarning, problemOf, sessionRunner, sessionStore, storeNote, valueOf, withNote, workerOffer } from './board-store'
import type { SessionBoard } from './board-store'
import { DEFAULT_VIEW, paneTree } from './pane'

// Change a shape tag when the fields of its value change: a value stored by an older version then reads as the initial value.
const runRef = atom({ plugin: 'meld', key: 'run' } as const, null, { shape: 'run-4' })
const factsRef = atom({ plugin: 'meld', key: 'facts' } as const, null, { shape: 'facts-1' })
const viewRef = atom({ plugin: 'meld', key: 'view' } as const, null, { shape: 'view-1' })
const boardRef = atom({ plugin: 'meld', key: 'board' } as const, null, { shape: 'board-1' })
const PROCESS_TIMEOUT_MS = 120_000
const FACTS_MS = 3000
const ENDED_AGENT = new Set<AgentStatus>(['completed', 'failed', 'killed'])
const START_KEY = 'start'
const PRESS_KEYS = [START_KEY, ...STEER_PRESETS.map(preset => `preset-${preset.key}`)]
/** The longest reason that a refusal quotes from a failed hook. */
const REASON_CHARS = 300

let sessionCwd = ''
/** The board of this session in meld mcp. With no board server, each hook keeps the run in the session state, as meld 0.8 does. */
const board: SessionBoard = { server: '', id: '', owner: '', problem: '', channel: '' }
let refreshing = false
/** The resumes of meld workers that run now: the engine checks the offer of their type during each one. */
let resuming = 0

/** Runs the send of a resume while meld offers the type of its workers. */
async function offering<T>(send: () => Promise<T>): Promise<T> {
  resuming += 1
  try {
    return await send()
  } finally {
    resuming -= 1
  }
}

/** The refusal of a meld call whose hook failed: it names the reason, so the agent and the person can tell a broken board from a lost race. */
function failedText(what: string, error: HookFailure): string {
  const reason = error.message ? `${error.kind}: ${error.message.slice(0, REASON_CHARS)}` : error.kind
  return `meld: ${what} failed (${reason}). Try the call again.`
}

function stateOf(status: AgentStatus): AgentState {
  return ENDED_AGENT.has(status) ? 'ended' : 'live'
}

/**
 * Each hook builds its own Io below: a hooks module spells `$` only at its call sites, never passes it on.
 *
 * An agent that a hook spawns runs under that hook and skips it. So a hook that spawns workers never serves them: the
 * start, steer and stop tools of the main session have a hook of their own, the board another, and the guard of every
 * other tool a third. An agent that a clock or a button closure starts skips every meld hook, so the clock only reads
 * facts, and a ui.press and a ui.input hook serve the buttons and fields that start agents.
 *
 * Restarts start in the main loop alone, from hooks that no worker needs: the end of a turn of the main session (the
 * engine tells the main session when a worker ends), the steer and the pane. An agent that the turn hook starts skips
 * it, so meld finds the end of that agent in the agent list of the engine.
 */
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionCwd = e.cwd
    const connected = await $.mcp.connect('board').catch((error: unknown) => ({ isConnected: false as const, reason: 'failed', message: String(error) }))
    board.server = connected.isConnected ? connected.server : ''
    board.problem = connected.isConnected ? '' : problemOf(connected)
    board.channel = board.server ? await $.mcp.call(board.server, 'board_channel', {}).then(result => valueOf<{ socketPath: string }>(result).socketPath, () => '') : ''
    board.owner = await $.session.id()
    board.id = (await read($, boardRef)) ?? board.owner
    if (board.server) await $.mcp.call(board.server, 'lead_board', { board: board.id, owner: board.owner }).catch(() => undefined)
    const sessionState: Store & FactsStore = {
      read: () => read($, runRef),
      write: change => update($, runRef, change),
      readFacts: () => read($, factsRef),
      writeFacts: facts => update($, factsRef, () => facts),
    }
    const io: Io = {
      run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
      now: () => $.clock.now(),
      random: count => crypto.getRandomValues(new Uint8Array(count)),
      cost: async () => (await $.session.usage()).cost?.usd,
      sleep: ms => $.clock.sleep(ms),
      ...sessionStore(
        board,
        {
          read: async () => valueOf<BoardRead>(await $.mcp.call(board.server, 'read_board', { board: board.id })),
          commit: async (run, version) => valueOf<{ result: Committed }>(await $.mcp.call(board.server, 'commit_board', { board: board.id, run, version, owner: board.owner })).result,
        },
        sessionState,
      ),
      writeFile: (path, text) => $.fs.write(path, text),
      ...sessionRunner(
        board,
        {
          spawn: async args => {
            const spawned = await $.agent.spawn(args.model ? args : { prompt: args.prompt, description: args.description, subagentType: args.subagentType, cwd: args.cwd })
            return { agentId: spawned.agentId, deny: spawned.deny }
          },
          send: (agentId, text) => $.session.send({ to: { agentId }, text }),
          resume: async (agentId, text) => (await offering(() => $.session.send({ to: { agentId }, text }))).isDelivered,
          agents: () => $.agent.list().then(list => new Map(list.map(agent => [agent.id, stateOf(agent.status)])), () => undefined),
        },
        {
          spawn: async args => valueOf<Spawned>(await $.mcp.call(board.server, 'spawn_worker', { board: board.id, subagentType: args.subagentType, cwd: args.cwd, prompt: args.prompt, description: args.description })),
          send: async (agentId, text) => valueOf(await $.mcp.call(board.server, 'send_worker', { agent: agentId, text })),
          agents: async () => new Map(Object.entries(valueOf<{ agents: Record<string, AgentState> }>(await $.mcp.call(board.server, 'acp_agents', {})).agents)),
        },
      ),
      command: (name, args) => $.command.run({ command: name, args }),
      toast: text => $.ui.toast(text),
      openPane: focus => $.ui.open(focus ? { id: 'meld', title: 'meld', focus: true } : { id: 'meld', title: 'meld' }),
    }
    for (const spec of TOOL_SPECS) await $.tool.register(spec)
    await $.agent
      .register({ name: 'worker', description: 'A meld worker. meld starts it for a run; never start it yourself.', prompt: WORKER_SYSTEM, autoCompactWindow: CONTEXT_CAP })
      .catch(() => $.ui.toast('meld: the meld:worker agent type did not register; use --agents with another type.'))
    await $.command.register({ name: 'meld', description: 'Start several agents on one task, each in its own workspace', argumentHint: '[--agents 3] [--model sonnet] [--vcs jj] <task>' })
    await $.command.register({ name: 'meld-steer', description: 'Give every meld worker a new instruction', argumentHint: '<instruction>', immediate: true })
    await $.command.register({ name: 'meld-status', description: 'Open the meld pane', immediate: true })
    await $.command.register({ name: 'meld-stop', description: 'Stop the meld workers; their workspaces stay', immediate: true })
    await $.command.register({ name: 'meld-clean', description: 'List the folders of old meld runs, or remove them', argumentHint: '[<id>...] [--all]', immediate: true })
    await $.command.register({ name: 'meld-deliver', description: 'Merge the final commit of the meld run into your branch', immediate: true })
    await $.command.register({ name: 'meld-discard', description: 'Stop the meld run and remove its workspaces', immediate: true })
    await $.command.register({ name: 'meld-add', description: 'Add a worker to the meld run', argumentHint: '[model | agent type | type@model]', immediate: true })
    await $.command.register({ name: 'meld-resume', description: 'List the meld runs of other sessions, or resume one', argumentHint: '[<board>]', immediate: true })
    // A timer runs outside every hook, so the engine would ask the person about each call of meld mcp. It reads the
    // board over the channel of meld mcp into the copy, and the facts from the copy.
    $.clock.every(FACTS_MS, () => {
      if (refreshing) return
      refreshing = true
      void copyFromChannel(board, url => $.http.fetch(url, { socketPath: board.channel }), sessionState)
        .catch(() => undefined)
        .then(() => refreshFacts({ ...io, ...sessionState }))
        .catch(() => undefined)
        .finally(() => {
          refreshing = false
        })
    })
    return next(e)
  })

  on('agent.offer', { agent: WORKER_TYPE }, ($, e, next) => workerOffer(resuming > 0) ?? next(e)).catch(($, e, next) => (next.called ? next(e) : { isOffered: false }))

  on('tool.check', { tool: BOARD_STORE_TOOLS }, ($, e, next) => boardVerdict(String(e.tool), board.server, next.origin.plugin) ?? next(e)).catch(() => ({
    decision: 'deny',
  }))

  // A worker runs git -C or jj -R with its own folder, and the engine asks a person for that form: see vcsVerdict.
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => vcsVerdict(await next(e), e.agentId, String((e.input as { command?: unknown }).command ?? ''), await read($, runRef))).catch(
    ($, e, next) => next(e),
  )

  // A worker spawn is an Agent call that meld raises, and auto mode cannot link it to the person: see spawnVerdict.
  on('tool.check', { tool: 'Agent' }, async ($, e, next) => spawnVerdict(await next(e), next.origin.plugin, await read($, runRef))).catch(
    ($, e, next) => next(e),
  )

  on('command.run', { command: ['meld', 'meld-steer', 'meld-status', 'meld-stop', 'meld-clean', 'meld-deliver', 'meld-discard', 'meld-add', 'meld-resume'] }, async ($, e) => {
    const io: Io & Files & RunRecords = {
      run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
      now: () => $.clock.now(),
      random: count => crypto.getRandomValues(new Uint8Array(count)),
      cost: async () => (await $.session.usage()).cost?.usd,
      sleep: ms => $.clock.sleep(ms),
      ...sessionStore(
        board,
        {
          read: async () => valueOf<BoardRead>(await $.mcp.call(board.server, 'read_board', { board: board.id })),
          commit: async (run, version) => valueOf<{ result: Committed }>(await $.mcp.call(board.server, 'commit_board', { board: board.id, run, version, owner: board.owner })).result,
        },
        {
          read: () => read($, runRef),
          write: change => update($, runRef, change),
          readFacts: () => read($, factsRef),
          writeFacts: facts => update($, factsRef, () => facts),
        },
      ),
      writeFile: (path, text) => $.fs.write(path, text),
      ...sessionRunner(
        board,
        {
          spawn: async args => {
            const spawned = await $.agent.spawn(args.model ? args : { prompt: args.prompt, description: args.description, subagentType: args.subagentType, cwd: args.cwd })
            return { agentId: spawned.agentId, deny: spawned.deny }
          },
          send: (agentId, text) => $.session.send({ to: { agentId }, text }),
          resume: async (agentId, text) => (await offering(() => $.session.send({ to: { agentId }, text }))).isDelivered,
          agents: () => $.agent.list().then(list => new Map(list.map(agent => [agent.id, stateOf(agent.status)])), () => undefined),
        },
        {
          spawn: async args => valueOf<Spawned>(await $.mcp.call(board.server, 'spawn_worker', { board: board.id, subagentType: args.subagentType, cwd: args.cwd, prompt: args.prompt, description: args.description })),
          send: async (agentId, text) => valueOf(await $.mcp.call(board.server, 'send_worker', { agent: agentId, text })),
          agents: async () => new Map(Object.entries(valueOf<{ agents: Record<string, AgentState> }>(await $.mcp.call(board.server, 'acp_agents', {})).agents)),
        },
      ),
      command: (name, args) => $.command.run({ command: name, args }),
      toast: text => $.ui.toast(text),
      openPane: focus => $.ui.open(focus ? { id: 'meld', title: 'meld', focus: true } : { id: 'meld', title: 'meld' }),
      list: path => $.fs.list(path),
      runRecords: async () => (board.server ? valueOf<{ runs: RunRecord[] }>(await $.mcp.call(board.server, 'run_records', {})).runs : []),
    }
    const args = e.args.trim()
    if (e.command === 'meld') {
      const options = parseStart(args)
      if ('error' in options) return { text: options.error }
      const before = await io.read()
      const started = await startRun(io, sessionCwd, options)
      const warning = noBoardWarning(board, before, await io.read())
      return warning ? { text: `${started.text ?? ''}\n\n${warning}` } : started
    }
    const control = COMMAND_CONTROLS[e.command as keyof typeof COMMAND_CONTROLS]
    if (control) return { text: await controlRun(io, control, args) }
    if (e.command === 'meld-clean') return { text: await cleanFolders(io, args) }
    if (e.command === 'meld-resume') {
      const boards: Boards | undefined = board.server
        ? {
            current: () => board.id,
            list: async () => valueOf<{ boards: BoardSummary[] }>(await $.mcp.call(board.server, 'list_boards', {})).boards,
            adopt: async id => adoptedOf(valueOf(await $.mcp.call(board.server, 'adopt_board', { board: id, owner: board.owner }))),
            use: async id => {
              board.id = id
              await update($, boardRef, () => id)
              await $.mcp.call(board.server, 'lead_board', { board: id, owner: board.owner }).catch(() => undefined)
            },
          }
        : undefined
      return { text: await resumeRun(io, boards ?? board.problem, args) }
    }
    await io.openPane(true)
    return { text: 'The pane is open.' }
  })

  on('tool.call', { tool: SESSION_TOOLS }, async ($, e) => {
    const io: Io = {
      run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
      now: () => $.clock.now(),
      random: count => crypto.getRandomValues(new Uint8Array(count)),
      cost: async () => (await $.session.usage()).cost?.usd,
      sleep: ms => $.clock.sleep(ms),
      ...sessionStore(
        board,
        {
          read: async () => valueOf<BoardRead>(await $.mcp.call(board.server, 'read_board', { board: board.id })),
          commit: async (run, version) => valueOf<{ result: Committed }>(await $.mcp.call(board.server, 'commit_board', { board: board.id, run, version, owner: board.owner })).result,
        },
        {
          read: () => read($, runRef),
          write: change => update($, runRef, change),
          readFacts: () => read($, factsRef),
          writeFacts: facts => update($, factsRef, () => facts),
        },
      ),
      writeFile: (path, text) => $.fs.write(path, text),
      ...sessionRunner(
        board,
        {
          spawn: async args => {
            const spawned = await $.agent.spawn(args.model ? args : { prompt: args.prompt, description: args.description, subagentType: args.subagentType, cwd: args.cwd })
            return { agentId: spawned.agentId, deny: spawned.deny }
          },
          send: (agentId, text) => $.session.send({ to: { agentId }, text }),
          resume: async (agentId, text) => (await offering(() => $.session.send({ to: { agentId }, text }))).isDelivered,
          agents: () => $.agent.list().then(list => new Map(list.map(agent => [agent.id, stateOf(agent.status)])), () => undefined),
        },
        {
          spawn: async args => valueOf<Spawned>(await $.mcp.call(board.server, 'spawn_worker', { board: board.id, subagentType: args.subagentType, cwd: args.cwd, prompt: args.prompt, description: args.description })),
          send: async (agentId, text) => valueOf(await $.mcp.call(board.server, 'send_worker', { agent: agentId, text })),
          agents: async () => new Map(Object.entries(valueOf<{ agents: Record<string, AgentState> }>(await $.mcp.call(board.server, 'acp_agents', {})).agents)),
        },
      ),
      command: (name, args) => $.command.run({ command: name, args }),
      toast: text => $.ui.toast(text),
      openPane: focus => $.ui.open(focus ? { id: 'meld', title: 'meld', focus: true } : { id: 'meld', title: 'meld' }),
    }
    const starts = String(e.tool) === TOOL.start
    const before = starts ? await io.read() : null
    const replied = await serveTool(io, e, sessionCwd)
    const warning = starts ? noBoardWarning(board, before, await io.read()) : ''
    return warning && 'result' in replied ? withNote(replied, { ...storeNote(board), warning }) : replied
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    const deny = failedText('the control of the run', next.error)
    $.ui.log(deny, { to: 'debug' })
    return { deny }
  })

  on(
    'tool.call',
    {
      tool: BOARD_TOOLS,
    },
    async ($, e) => {
      const io: Io = {
        run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
        now: () => $.clock.now(),
        random: count => crypto.getRandomValues(new Uint8Array(count)),
        cost: async () => (await $.session.usage()).cost?.usd,
        sleep: ms => $.clock.sleep(ms),
        ...sessionStore(
          board,
          {
            read: async () => valueOf<BoardRead>(await $.mcp.call(board.server, 'read_board', { board: board.id })),
            commit: async (run, version) => valueOf<{ result: Committed }>(await $.mcp.call(board.server, 'commit_board', { board: board.id, run, version, owner: board.owner })).result,
          },
          {
            read: () => read($, runRef),
            write: change => update($, runRef, change),
            readFacts: () => read($, factsRef),
            writeFacts: facts => update($, factsRef, () => facts),
          },
        ),
        writeFile: (path, text) => $.fs.write(path, text),
        ...sessionRunner(
          board,
          {
            spawn: async args => {
              const spawned = await $.agent.spawn(args.model ? args : { prompt: args.prompt, description: args.description, subagentType: args.subagentType, cwd: args.cwd })
              return { agentId: spawned.agentId, deny: spawned.deny }
            },
            send: (agentId, text) => $.session.send({ to: { agentId }, text }),
            resume: async (agentId, text) => (await offering(() => $.session.send({ to: { agentId }, text }))).isDelivered,
            agents: () => $.agent.list().then(list => new Map(list.map(agent => [agent.id, stateOf(agent.status)])), () => undefined),
          },
          {
            spawn: async args => valueOf<Spawned>(await $.mcp.call(board.server, 'spawn_worker', { board: board.id, subagentType: args.subagentType, cwd: args.cwd, prompt: args.prompt, description: args.description })),
            send: async (agentId, text) => valueOf(await $.mcp.call(board.server, 'send_worker', { agent: agentId, text })),
            agents: async () => new Map(Object.entries(valueOf<{ agents: Record<string, AgentState> }>(await $.mcp.call(board.server, 'acp_agents', {})).agents)),
          },
        ),
        command: (name, args) => $.command.run({ command: name, args }),
        toast: text => $.ui.toast(text),
        openPane: focus => $.ui.open(focus ? { id: 'meld', title: 'meld', focus: true } : { id: 'meld', title: 'meld' }),
      }
      const replied = await serveTool(io, e)
      return e.agentId === undefined && String(e.tool) === TOOL.board ? withNote(replied, storeNote(board)) : replied
    },
  ).catch(($, e, next) => {
    if (next.called) return next(e)
    const deny = failedText('the board', next.error)
    $.ui.log(deny, { to: 'debug' })
    return { deny }
  })

  on('tool.call', async ($, e, next) => {
    if (String(e.tool).startsWith(TOOL_PREFIX)) return next(e)
    const io: Io = {
      run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
      now: () => $.clock.now(),
      random: count => crypto.getRandomValues(new Uint8Array(count)),
      cost: async () => (await $.session.usage()).cost?.usd,
      sleep: ms => $.clock.sleep(ms),
      ...sessionStore(
        board,
        {
          read: async () => valueOf<BoardRead>(await $.mcp.call(board.server, 'read_board', { board: board.id })),
          commit: async (run, version) => valueOf<{ result: Committed }>(await $.mcp.call(board.server, 'commit_board', { board: board.id, run, version, owner: board.owner })).result,
        },
        {
          read: () => read($, runRef),
          write: change => update($, runRef, change),
          readFacts: () => read($, factsRef),
          writeFacts: facts => update($, factsRef, () => facts),
        },
      ),
      writeFile: (path, text) => $.fs.write(path, text),
      ...sessionRunner(
        board,
        {
          spawn: async args => {
            const spawned = await $.agent.spawn(args.model ? args : { prompt: args.prompt, description: args.description, subagentType: args.subagentType, cwd: args.cwd })
            return { agentId: spawned.agentId, deny: spawned.deny }
          },
          send: (agentId, text) => $.session.send({ to: { agentId }, text }),
          resume: async (agentId, text) => (await offering(() => $.session.send({ to: { agentId }, text }))).isDelivered,
          agents: () => $.agent.list().then(list => new Map(list.map(agent => [agent.id, stateOf(agent.status)])), () => undefined),
        },
        {
          spawn: async args => valueOf<Spawned>(await $.mcp.call(board.server, 'spawn_worker', { board: board.id, subagentType: args.subagentType, cwd: args.cwd, prompt: args.prompt, description: args.description })),
          send: async (agentId, text) => valueOf(await $.mcp.call(board.server, 'send_worker', { agent: agentId, text })),
          agents: async () => new Map(Object.entries(valueOf<{ agents: Record<string, AgentState> }>(await $.mcp.call(board.server, 'acp_agents', {})).agents)),
        },
      ),
      command: (name, args) => $.command.run({ command: name, args }),
      toast: text => $.ui.toast(text),
      openPane: focus => $.ui.open(focus ? { id: 'meld', title: 'meld', focus: true } : { id: 'meld', title: 'meld' }),
    }
    const deny = await guardCall(io, e)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => {
    // The guard lets the call through when it fails, so a broken board does not stop every tool of the session. The debug log keeps the reason.
    $.ui.log(failedText('the guard of tool calls', next.error), { to: 'debug' })
    return next(e)
  })


  /** Each model call of a worker adds its tokens at once: a worker does a task in one long turn. */
  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    if (e.agentId === undefined) return response
    const io: Io = {
      run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
      now: () => $.clock.now(),
      random: count => crypto.getRandomValues(new Uint8Array(count)),
      cost: async () => (await $.session.usage()).cost?.usd,
      sleep: ms => $.clock.sleep(ms),
      ...sessionStore(
        board,
        {
          read: async () => valueOf<BoardRead>(await $.mcp.call(board.server, 'read_board', { board: board.id })),
          commit: async (run, version) => valueOf<{ result: Committed }>(await $.mcp.call(board.server, 'commit_board', { board: board.id, run, version, owner: board.owner })).result,
        },
        {
          read: () => read($, runRef),
          write: change => update($, runRef, change),
          readFacts: () => read($, factsRef),
          writeFacts: facts => update($, factsRef, () => facts),
        },
      ),
      writeFile: (path, text) => $.fs.write(path, text),
      ...sessionRunner(
        board,
        {
          spawn: async args => {
            const spawned = await $.agent.spawn(args.model ? args : { prompt: args.prompt, description: args.description, subagentType: args.subagentType, cwd: args.cwd })
            return { agentId: spawned.agentId, deny: spawned.deny }
          },
          send: (agentId, text) => $.session.send({ to: { agentId }, text }),
          resume: async (agentId, text) => (await offering(() => $.session.send({ to: { agentId }, text }))).isDelivered,
          agents: () => $.agent.list().then(list => new Map(list.map(agent => [agent.id, stateOf(agent.status)])), () => undefined),
        },
        {
          spawn: async args => valueOf<Spawned>(await $.mcp.call(board.server, 'spawn_worker', { board: board.id, subagentType: args.subagentType, cwd: args.cwd, prompt: args.prompt, description: args.description })),
          send: async (agentId, text) => valueOf(await $.mcp.call(board.server, 'send_worker', { agent: agentId, text })),
          agents: async () => new Map(Object.entries(valueOf<{ agents: Record<string, AgentState> }>(await $.mcp.call(board.server, 'acp_agents', {})).agents)),
        },
      ),
      command: (name, args) => $.command.run({ command: name, args }),
      toast: text => $.ui.toast(text),
      openPane: focus => $.ui.open(focus ? { id: 'meld', title: 'meld', focus: true } : { id: 'meld', title: 'meld' }),
    }
    const window = await $.session.usage().then(usage => usage.context?.window, () => undefined)
    await countStep(io, e.agentId, response.usage, window).catch(() => undefined)
    return response
  })

  /**
   * A worker compacts at CONTEXT_CAP: the summary keeps its task, and its next board read gives its rules again.
   * ponytail: a precompute counts as the compaction, so a board read before the swap can take the rules early.
   */
  on('session.compact', async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const io: Store = sessionStore(
      board,
      {
        read: async () => valueOf<BoardRead>(await $.mcp.call(board.server, 'read_board', { board: board.id })),
        commit: async (run, version) => valueOf<{ result: Committed }>(await $.mcp.call(board.server, 'commit_board', { board: board.id, run, version, owner: board.owner })).result,
      },
      {
        read: () => read($, runRef),
        write: change => update($, runRef, change),
        readFacts: () => read($, factsRef),
        writeFacts: facts => update($, factsRef, () => facts),
      },
    )
    const keep = await compactWorker(io, e.agentId)
    return next(keep ? { ...e, instructions: e.instructions ? `${e.instructions}\n\n${keep}` : keep } : e)
  }).catch(($, e, next) => next(e))


  on('turn.complete', async ($, e, next) => {
    const io: Io = {
      run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
      now: () => $.clock.now(),
      random: count => crypto.getRandomValues(new Uint8Array(count)),
      cost: async () => (await $.session.usage()).cost?.usd,
      sleep: ms => $.clock.sleep(ms),
      ...sessionStore(
        board,
        {
          read: async () => valueOf<BoardRead>(await $.mcp.call(board.server, 'read_board', { board: board.id })),
          commit: async (run, version) => valueOf<{ result: Committed }>(await $.mcp.call(board.server, 'commit_board', { board: board.id, run, version, owner: board.owner })).result,
        },
        {
          read: () => read($, runRef),
          write: change => update($, runRef, change),
          readFacts: () => read($, factsRef),
          writeFacts: facts => update($, factsRef, () => facts),
        },
      ),
      writeFile: (path, text) => $.fs.write(path, text),
      ...sessionRunner(
        board,
        {
          spawn: async args => {
            const spawned = await $.agent.spawn(args.model ? args : { prompt: args.prompt, description: args.description, subagentType: args.subagentType, cwd: args.cwd })
            return { agentId: spawned.agentId, deny: spawned.deny }
          },
          send: (agentId, text) => $.session.send({ to: { agentId }, text }),
          resume: async (agentId, text) => (await offering(() => $.session.send({ to: { agentId }, text }))).isDelivered,
          agents: () => $.agent.list().then(list => new Map(list.map(agent => [agent.id, stateOf(agent.status)])), () => undefined),
        },
        {
          spawn: async args => valueOf<Spawned>(await $.mcp.call(board.server, 'spawn_worker', { board: board.id, subagentType: args.subagentType, cwd: args.cwd, prompt: args.prompt, description: args.description })),
          send: async (agentId, text) => valueOf(await $.mcp.call(board.server, 'send_worker', { agent: agentId, text })),
          agents: async () => new Map(Object.entries(valueOf<{ agents: Record<string, AgentState> }>(await $.mcp.call(board.server, 'acp_agents', {})).agents)),
        },
      ),
      command: (name, args) => $.command.run({ command: name, args }),
      toast: text => $.ui.toast(text),
      openPane: focus => $.ui.open(focus ? { id: 'meld', title: 'meld', focus: true } : { id: 'meld', title: 'meld' }),
    }
    const completed = await next(e)
    await markWorker(io, e.agentId, 'idle')
    if (e.agentId === undefined) await restartIdleWorkers(io)
    const actions = board.server ? await $.mcp.call(board.server, 'take_actions', { board: board.id }).then(result => valueOf<{ actions: Action[] }>(result).actions, () => []) : []
    for (const action of actions) {
      if (action.kind === 'toast') $.ui.toast(action.text)
      else await $.session.send({ to: { agentId: action.agent }, text: action.text }).catch(() => undefined)
    }
    return completed
  })


  on('ui.render', { component: 'Pane', requestId: 'meld' }, async ($, e) => {
    const io: Io = {
      run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
      now: () => $.clock.now(),
      random: count => crypto.getRandomValues(new Uint8Array(count)),
      cost: async () => (await $.session.usage()).cost?.usd,
      sleep: ms => $.clock.sleep(ms),
      ...sessionStore(
        board,
        {
          read: async () => valueOf<BoardRead>(await $.mcp.call(board.server, 'read_board', { board: board.id })),
          commit: async (run, version) => valueOf<{ result: Committed }>(await $.mcp.call(board.server, 'commit_board', { board: board.id, run, version, owner: board.owner })).result,
        },
        {
          read: () => read($, runRef),
          write: change => update($, runRef, change),
          readFacts: () => read($, factsRef),
          writeFacts: facts => update($, factsRef, () => facts),
        },
      ),
      writeFile: (path, text) => $.fs.write(path, text),
      ...sessionRunner(
        board,
        {
          spawn: async args => {
            const spawned = await $.agent.spawn(args.model ? args : { prompt: args.prompt, description: args.description, subagentType: args.subagentType, cwd: args.cwd })
            return { agentId: spawned.agentId, deny: spawned.deny }
          },
          send: (agentId, text) => $.session.send({ to: { agentId }, text }),
          resume: async (agentId, text) => (await offering(() => $.session.send({ to: { agentId }, text }))).isDelivered,
          agents: () => $.agent.list().then(list => new Map(list.map(agent => [agent.id, stateOf(agent.status)])), () => undefined),
        },
        {
          spawn: async args => valueOf<Spawned>(await $.mcp.call(board.server, 'spawn_worker', { board: board.id, subagentType: args.subagentType, cwd: args.cwd, prompt: args.prompt, description: args.description })),
          send: async (agentId, text) => valueOf(await $.mcp.call(board.server, 'send_worker', { agent: agentId, text })),
          agents: async () => new Map(Object.entries(valueOf<{ agents: Record<string, AgentState> }>(await $.mcp.call(board.server, 'acp_agents', {})).agents)),
        },
      ),
      command: (name, args) => $.command.run({ command: name, args }),
      toast: text => $.ui.toast(text),
      openPane: focus => $.ui.open(focus ? { id: 'meld', title: 'meld', focus: true } : { id: 'meld', title: 'meld' }),
    }
    return paneTree({
      table: $.ui.resolve(e),
      surface: e.surface,
      run: await read($, runRef),
      facts: await read($, factsRef),
      view: (await read($, viewRef)) ?? DEFAULT_VIEW,
      now: await $.clock.now(),
      sessionCost: (await $.session.usage().catch(() => undefined))?.cost?.usd,
      io,
      setView: change => update($, viewRef, view => change(view ?? DEFAULT_VIEW)),
    })
  })

  on('ui.press', { plugin: 'meld', element: PRESS_KEYS }, async ($, e) => {
    const io: Io = {
      run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
      now: () => $.clock.now(),
      random: count => crypto.getRandomValues(new Uint8Array(count)),
      cost: async () => (await $.session.usage()).cost?.usd,
      sleep: ms => $.clock.sleep(ms),
      ...sessionStore(
        board,
        {
          read: async () => valueOf<BoardRead>(await $.mcp.call(board.server, 'read_board', { board: board.id })),
          commit: async (run, version) => valueOf<{ result: Committed }>(await $.mcp.call(board.server, 'commit_board', { board: board.id, run, version, owner: board.owner })).result,
        },
        {
          read: () => read($, runRef),
          write: change => update($, runRef, change),
          readFacts: () => read($, factsRef),
          writeFacts: facts => update($, factsRef, () => facts),
        },
      ),
      writeFile: (path, text) => $.fs.write(path, text),
      ...sessionRunner(
        board,
        {
          spawn: async args => {
            const spawned = await $.agent.spawn(args.model ? args : { prompt: args.prompt, description: args.description, subagentType: args.subagentType, cwd: args.cwd })
            return { agentId: spawned.agentId, deny: spawned.deny }
          },
          send: (agentId, text) => $.session.send({ to: { agentId }, text }),
          resume: async (agentId, text) => (await offering(() => $.session.send({ to: { agentId }, text }))).isDelivered,
          agents: () => $.agent.list().then(list => new Map(list.map(agent => [agent.id, stateOf(agent.status)])), () => undefined),
        },
        {
          spawn: async args => valueOf<Spawned>(await $.mcp.call(board.server, 'spawn_worker', { board: board.id, subagentType: args.subagentType, cwd: args.cwd, prompt: args.prompt, description: args.description })),
          send: async (agentId, text) => valueOf(await $.mcp.call(board.server, 'send_worker', { agent: agentId, text })),
          agents: async () => new Map(Object.entries(valueOf<{ agents: Record<string, AgentState> }>(await $.mcp.call(board.server, 'acp_agents', {})).agents)),
        },
      ),
      command: (name, args) => $.command.run({ command: name, args }),
      toast: text => $.ui.toast(text),
      openPane: focus => $.ui.open(focus ? { id: 'meld', title: 'meld', focus: true } : { id: 'meld', title: 'meld' }),
    }
    const preset = STEER_PRESETS.find(one => `preset-${one.key}` === e.element)
    const view = (await read($, viewRef)) ?? DEFAULT_VIEW
    io.toast(`meld: ${preset ? await steerRun(io, preset.text) : await startFromView(io, sessionCwd, view)}`)
    if (!preset && view.task.trim()) await update($, viewRef, current => ({ ...(current ?? DEFAULT_VIEW), task: '' }))
    return { element: e.element }
  })

  on('ui.input', { plugin: 'meld', element: ['task', 'steer'] }, async ($, e, next) => {
    if (e.kind !== 'submit') return next(e)
    const io: Io = {
      run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
      now: () => $.clock.now(),
      random: count => crypto.getRandomValues(new Uint8Array(count)),
      cost: async () => (await $.session.usage()).cost?.usd,
      sleep: ms => $.clock.sleep(ms),
      ...sessionStore(
        board,
        {
          read: async () => valueOf<BoardRead>(await $.mcp.call(board.server, 'read_board', { board: board.id })),
          commit: async (run, version) => valueOf<{ result: Committed }>(await $.mcp.call(board.server, 'commit_board', { board: board.id, run, version, owner: board.owner })).result,
        },
        {
          read: () => read($, runRef),
          write: change => update($, runRef, change),
          readFacts: () => read($, factsRef),
          writeFacts: facts => update($, factsRef, () => facts),
        },
      ),
      writeFile: (path, text) => $.fs.write(path, text),
      ...sessionRunner(
        board,
        {
          spawn: async args => {
            const spawned = await $.agent.spawn(args.model ? args : { prompt: args.prompt, description: args.description, subagentType: args.subagentType, cwd: args.cwd })
            return { agentId: spawned.agentId, deny: spawned.deny }
          },
          send: (agentId, text) => $.session.send({ to: { agentId }, text }),
          resume: async (agentId, text) => (await offering(() => $.session.send({ to: { agentId }, text }))).isDelivered,
          agents: () => $.agent.list().then(list => new Map(list.map(agent => [agent.id, stateOf(agent.status)])), () => undefined),
        },
        {
          spawn: async args => valueOf<Spawned>(await $.mcp.call(board.server, 'spawn_worker', { board: board.id, subagentType: args.subagentType, cwd: args.cwd, prompt: args.prompt, description: args.description })),
          send: async (agentId, text) => valueOf(await $.mcp.call(board.server, 'send_worker', { agent: agentId, text })),
          agents: async () => new Map(Object.entries(valueOf<{ agents: Record<string, AgentState> }>(await $.mcp.call(board.server, 'acp_agents', {})).agents)),
        },
      ),
      command: (name, args) => $.command.run({ command: name, args }),
      toast: text => $.ui.toast(text),
      openPane: focus => $.ui.open(focus ? { id: 'meld', title: 'meld', focus: true } : { id: 'meld', title: 'meld' }),
    }
    const view = (await read($, viewRef)) ?? DEFAULT_VIEW
    io.toast(`meld: ${e.element === 'steer' ? await steerRun(io, e.value.trim()) : await startFromView(io, sessionCwd, { ...view, task: e.value })}`)
    if (e.element === 'task' && e.value.trim()) await update($, viewRef, current => ({ ...(current ?? DEFAULT_VIEW), task: '' }))
    return { element: e.element, value: e.value }
  })
}
