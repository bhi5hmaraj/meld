import { atom, read, update } from 'claude-code'
import type { AgentStatus, Register } from 'claude-code'

import { controlRun, countStep, guardCall, markWorker, refreshFacts, restartIdleWorkers, serveTool, spawnVerdict, startFromView, startRun, steerRun, stopAll } from '../core/actions'
import { cleanFolders } from '../core/clean'
import type { BoardRead, Boards, BoardSummary, Committed } from '../core/remote-store'
import { resumeRun } from '../core/resume'
import { BOARD_TOOLS, COMMAND_CONTROLS, SESSION_TOOLS, STEER_PRESETS, TOOL, TOOL_SPECS, WORKER_SYSTEM } from '../core/contract'
import type { AgentState, FactsStore, Files, Io, Store } from '../core/ports'
import { parseStart, WORKER_TYPE } from '../core/options'
import { adoptedOf, BOARD_STORE_TOOLS, boardVerdict, problemOf, sessionStore, storeNote, valueOf, withNote } from './board-store'
import type { SessionBoard } from './board-store'
import { DEFAULT_VIEW, paneTree } from './pane'

const MELD_TOOL = 'mcp__meld__'
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

let sessionCwd = ''
/** The board of this session in meld mcp. With no board server, each hook keeps the run in the session state, as meld 0.8 does. */
const board: SessionBoard = { server: '', id: '', owner: '', problem: '' }
let refreshing = false

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
    board.owner = await $.session.id()
    board.id = (await read($, boardRef)) ?? board.owner
    const sessionState: Store & FactsStore = {
      read: () => read($, runRef),
      write: change => update($, runRef, change),
      readFacts: () => read($, factsRef),
      writeFacts: facts => update($, factsRef, () => facts),
    }
    const io: Io = {
      run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
      now: () => $.clock.now(),
      cost: async () => (await $.session.usage()).cost?.usd,
      agents: () => $.agent.list().then(list => new Map(list.map(agent => [agent.id, stateOf(agent.status)])), () => undefined),
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
      spawn: async args => {
        const spawned = await $.agent.spawn(args.model ? args : { prompt: args.prompt, description: args.description, subagentType: args.subagentType, cwd: args.cwd })
        return { agentId: spawned.agentId, deny: spawned.deny }
      },
      command: (name, args) => $.command.run({ command: name, args }),
      send: (agentId, text) => $.session.send({ to: { agentId }, text }),
      toast: text => $.ui.toast(text),
      openPane: focus => $.ui.open(focus ? { id: 'meld', title: 'meld', focus: true } : { id: 'meld', title: 'meld' }),
    }
    for (const spec of TOOL_SPECS) await $.tool.register(spec)
    await $.agent
      .register({ name: 'worker', description: 'A meld worker. meld starts it for a run; never start it yourself.', prompt: WORKER_SYSTEM })
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
    // A timer runs outside every hook, so the engine would ask the person about each call of meld mcp. It reads the copy.
    $.clock.every(FACTS_MS, () => {
      if (refreshing) return
      refreshing = true
      void refreshFacts({ ...io, ...sessionState })
        .catch(() => undefined)
        .finally(() => {
          refreshing = false
        })
    })
    return next(e)
  })

  on('agent.offer', { agent: WORKER_TYPE }, () => ({ isOffered: false }))

  on('tool.check', { tool: BOARD_STORE_TOOLS }, ($, e, next) => boardVerdict(String(e.tool), board.server, next.origin.plugin) ?? next(e)).catch(() => ({
    decision: 'deny',
  }))

  // A worker spawn is an Agent call that meld raises, and auto mode cannot link it to the person: see spawnVerdict.
  on('tool.check', { tool: 'Agent' }, async ($, e, next) => spawnVerdict(await next(e), next.origin.plugin, await read($, runRef))).catch(
    ($, e, next) => next(e),
  )

  on('command.run', { command: ['meld', 'meld-steer', 'meld-status', 'meld-stop', 'meld-clean', 'meld-deliver', 'meld-discard', 'meld-add', 'meld-resume'] }, async ($, e) => {
    const io: Io & Files = {
      run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
      now: () => $.clock.now(),
      cost: async () => (await $.session.usage()).cost?.usd,
      agents: () => $.agent.list().then(list => new Map(list.map(agent => [agent.id, stateOf(agent.status)])), () => undefined),
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
      spawn: async args => {
        const spawned = await $.agent.spawn(args.model ? args : { prompt: args.prompt, description: args.description, subagentType: args.subagentType, cwd: args.cwd })
        return { agentId: spawned.agentId, deny: spawned.deny }
      },
      command: (name, args) => $.command.run({ command: name, args }),
      send: (agentId, text) => $.session.send({ to: { agentId }, text }),
      toast: text => $.ui.toast(text),
      openPane: focus => $.ui.open(focus ? { id: 'meld', title: 'meld', focus: true } : { id: 'meld', title: 'meld' }),
      list: path => $.fs.list(path),
      readText: path => $.fs.read(path),
    }
    const args = e.args.trim()
    if (e.command === 'meld') {
      const options = parseStart(args)
      return 'error' in options ? { text: options.error } : startRun(io, sessionCwd, options)
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
      cost: async () => (await $.session.usage()).cost?.usd,
      agents: () => $.agent.list().then(list => new Map(list.map(agent => [agent.id, stateOf(agent.status)])), () => undefined),
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
      spawn: async args => {
        const spawned = await $.agent.spawn(args.model ? args : { prompt: args.prompt, description: args.description, subagentType: args.subagentType, cwd: args.cwd })
        return { agentId: spawned.agentId, deny: spawned.deny }
      },
      command: (name, args) => $.command.run({ command: name, args }),
      send: (agentId, text) => $.session.send({ to: { agentId }, text }),
      toast: text => $.ui.toast(text),
      openPane: focus => $.ui.open(focus ? { id: 'meld', title: 'meld', focus: true } : { id: 'meld', title: 'meld' }),
    }
    return serveTool(io, e, sessionCwd)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'meld: the control of the run failed. Try the call again.' }))

  on(
    'tool.call',
    {
      tool: BOARD_TOOLS,
    },
    async ($, e) => {
      const io: Io = {
        run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
        now: () => $.clock.now(),
        cost: async () => (await $.session.usage()).cost?.usd,
        agents: () => $.agent.list().then(list => new Map(list.map(agent => [agent.id, stateOf(agent.status)])), () => undefined),
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
        spawn: async args => {
          const spawned = await $.agent.spawn(args.model ? args : { prompt: args.prompt, description: args.description, subagentType: args.subagentType, cwd: args.cwd })
          return { agentId: spawned.agentId, deny: spawned.deny }
        },
        command: (name, args) => $.command.run({ command: name, args }),
        send: (agentId, text) => $.session.send({ to: { agentId }, text }),
        toast: text => $.ui.toast(text),
        openPane: focus => $.ui.open(focus ? { id: 'meld', title: 'meld', focus: true } : { id: 'meld', title: 'meld' }),
      }
      const replied = await serveTool(io, e)
      return e.agentId === undefined && String(e.tool) === TOOL.board ? withNote(replied, storeNote(board)) : replied
    },
  ).catch(($, e, next) => (next.called ? next(e) : { deny: 'meld: the board failed. Try the call again.' }))

  on('tool.call', async ($, e, next) => {
    if (String(e.tool).startsWith(MELD_TOOL)) return next(e)
    const io: Io = {
      run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
      now: () => $.clock.now(),
      cost: async () => (await $.session.usage()).cost?.usd,
      agents: () => $.agent.list().then(list => new Map(list.map(agent => [agent.id, stateOf(agent.status)])), () => undefined),
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
      spawn: async args => {
        const spawned = await $.agent.spawn(args.model ? args : { prompt: args.prompt, description: args.description, subagentType: args.subagentType, cwd: args.cwd })
        return { agentId: spawned.agentId, deny: spawned.deny }
      },
      command: (name, args) => $.command.run({ command: name, args }),
      send: (agentId, text) => $.session.send({ to: { agentId }, text }),
      toast: text => $.ui.toast(text),
      openPane: focus => $.ui.open(focus ? { id: 'meld', title: 'meld', focus: true } : { id: 'meld', title: 'meld' }),
    }
    const deny = await guardCall(io, e)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => next(e))


  /** Each model call of a worker adds its tokens at once: a worker does a task in one long turn. */
  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    if (e.agentId === undefined) return response
    const io: Io = {
      run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
      now: () => $.clock.now(),
      cost: async () => (await $.session.usage()).cost?.usd,
      agents: () => $.agent.list().then(list => new Map(list.map(agent => [agent.id, stateOf(agent.status)])), () => undefined),
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
      spawn: async args => {
        const spawned = await $.agent.spawn(args.model ? args : { prompt: args.prompt, description: args.description, subagentType: args.subagentType, cwd: args.cwd })
        return { agentId: spawned.agentId, deny: spawned.deny }
      },
      command: (name, args) => $.command.run({ command: name, args }),
      send: (agentId, text) => $.session.send({ to: { agentId }, text }),
      toast: text => $.ui.toast(text),
      openPane: focus => $.ui.open(focus ? { id: 'meld', title: 'meld', focus: true } : { id: 'meld', title: 'meld' }),
    }
    await countStep(io, e.agentId, response.usage).catch(() => undefined)
    return response
  })


  on('turn.complete', async ($, e, next) => {
    const io: Io = {
      run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
      now: () => $.clock.now(),
      cost: async () => (await $.session.usage()).cost?.usd,
      agents: () => $.agent.list().then(list => new Map(list.map(agent => [agent.id, stateOf(agent.status)])), () => undefined),
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
      spawn: async args => {
        const spawned = await $.agent.spawn(args.model ? args : { prompt: args.prompt, description: args.description, subagentType: args.subagentType, cwd: args.cwd })
        return { agentId: spawned.agentId, deny: spawned.deny }
      },
      command: (name, args) => $.command.run({ command: name, args }),
      send: (agentId, text) => $.session.send({ to: { agentId }, text }),
      toast: text => $.ui.toast(text),
      openPane: focus => $.ui.open(focus ? { id: 'meld', title: 'meld', focus: true } : { id: 'meld', title: 'meld' }),
    }
    const completed = await next(e)
    await markWorker(io, e.agentId, 'idle')
    if (e.agentId === undefined) await restartIdleWorkers(io)
    return completed
  })


  on('ui.render', { component: 'Pane', requestId: 'meld' }, async ($, e) => {
    const io: Io = {
      run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
      now: () => $.clock.now(),
      cost: async () => (await $.session.usage()).cost?.usd,
      agents: () => $.agent.list().then(list => new Map(list.map(agent => [agent.id, stateOf(agent.status)])), () => undefined),
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
      spawn: async args => {
        const spawned = await $.agent.spawn(args.model ? args : { prompt: args.prompt, description: args.description, subagentType: args.subagentType, cwd: args.cwd })
        return { agentId: spawned.agentId, deny: spawned.deny }
      },
      command: (name, args) => $.command.run({ command: name, args }),
      send: (agentId, text) => $.session.send({ to: { agentId }, text }),
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
      cost: async () => (await $.session.usage()).cost?.usd,
      agents: () => $.agent.list().then(list => new Map(list.map(agent => [agent.id, stateOf(agent.status)])), () => undefined),
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
      spawn: async args => {
        const spawned = await $.agent.spawn(args.model ? args : { prompt: args.prompt, description: args.description, subagentType: args.subagentType, cwd: args.cwd })
        return { agentId: spawned.agentId, deny: spawned.deny }
      },
      command: (name, args) => $.command.run({ command: name, args }),
      send: (agentId, text) => $.session.send({ to: { agentId }, text }),
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
      cost: async () => (await $.session.usage()).cost?.usd,
      agents: () => $.agent.list().then(list => new Map(list.map(agent => [agent.id, stateOf(agent.status)])), () => undefined),
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
      spawn: async args => {
        const spawned = await $.agent.spawn(args.model ? args : { prompt: args.prompt, description: args.description, subagentType: args.subagentType, cwd: args.cwd })
        return { agentId: spawned.agentId, deny: spawned.deny }
      },
      command: (name, args) => $.command.run({ command: name, args }),
      send: (agentId, text) => $.session.send({ to: { agentId }, text }),
      toast: text => $.ui.toast(text),
      openPane: focus => $.ui.open(focus ? { id: 'meld', title: 'meld', focus: true } : { id: 'meld', title: 'meld' }),
    }
    const view = (await read($, viewRef)) ?? DEFAULT_VIEW
    io.toast(`meld: ${e.element === 'steer' ? await steerRun(io, e.value.trim()) : await startFromView(io, sessionCwd, { ...view, task: e.value })}`)
    if (e.element === 'task' && e.value.trim()) await update($, viewRef, current => ({ ...(current ?? DEFAULT_VIEW), task: '' }))
    return { element: e.element, value: e.value }
  })
}
