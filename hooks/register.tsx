import { atom, read, update } from 'claude-code'
import type { Register, TurnUsage } from 'claude-code'

import { guardCall, markWorker, refreshFacts, serveTool, startRun, steerRun, stopAll } from './actions'
import { TOOL_SPECS, WORKER_SYSTEM } from './contract'
import type { Io } from './io'
import { parseStart, WORKER_TYPE } from './options'
import { DEFAULT_VIEW, paneTree } from './pane'

const MELD_TOOL = 'mcp__meld__'
// Change a shape tag when the fields of its value change: a value stored by an older version then reads as the initial value.
const runRef = atom({ plugin: 'meld', key: 'run' } as const, null, { shape: 'run-4' })
const factsRef = atom({ plugin: 'meld', key: 'facts' } as const, null, { shape: 'facts-1' })
const viewRef = atom({ plugin: 'meld', key: 'view' } as const, null, { shape: 'view-1' })
const PROCESS_TIMEOUT_MS = 120_000
const FACTS_MS = 3000

let sessionCwd = ''
let refreshing = false

function tokensOf(usage: TurnUsage | undefined): number {
  if (!usage) return 0
  return usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
}

/**
 * Each hook builds its own Io below: a hooks module spells `$` only at its call sites, never passes it on.
 *
 * An agent that a hook spawns runs under that hook and skips it. So a hook that spawns workers never serves them: the
 * start and stop tools of the main session have a hook of their own, the board another, and the guard of every other
 * tool a third. The Start button of the pane runs /meld, which the command hook serves.
 */
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionCwd = e.cwd
    const io: Io = {
      run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
      now: () => $.clock.now(),
      sleep: ms => $.clock.sleep(ms),
      read: () => read($, runRef),
      write: change => update($, runRef, change),
      readFacts: () => read($, factsRef),
      writeFacts: facts => update($, factsRef, () => facts),
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
    $.clock.every(FACTS_MS, () => {
      if (refreshing) return
      refreshing = true
      void refreshFacts(io)
        .catch(() => undefined)
        .finally(() => {
          refreshing = false
        })
    })
    return next(e)
  })

  on('agent.offer', { agent: WORKER_TYPE }, () => ({ isOffered: false }))

  on('command.run', { command: ['meld', 'meld-steer', 'meld-status', 'meld-stop'] }, async ($, e) => {
    const io: Io = {
      run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
      now: () => $.clock.now(),
      sleep: ms => $.clock.sleep(ms),
      read: () => read($, runRef),
      write: change => update($, runRef, change),
      readFacts: () => read($, factsRef),
      writeFacts: facts => update($, factsRef, () => facts),
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
    const args = e.args.trim()
    if (e.command === 'meld') {
      const options = parseStart(args)
      return 'error' in options ? { text: options.error } : startRun(io, sessionCwd, options)
    }
    if (e.command === 'meld-steer') return { text: await steerRun(io, args) }
    if (e.command === 'meld-stop') return { text: await stopAll(io) }
    await io.openPane(true)
    return { text: 'The pane is open.' }
  })

  on('tool.call', { tool: ['mcp__meld__start', 'mcp__meld__stop'] }, async ($, e) => {
    const io: Io = {
      run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
      now: () => $.clock.now(),
      sleep: ms => $.clock.sleep(ms),
      read: () => read($, runRef),
      write: change => update($, runRef, change),
      readFacts: () => read($, factsRef),
      writeFacts: facts => update($, factsRef, () => facts),
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
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'meld: the run could not start or stop. Try the call again.' }))

  on(
    'tool.call',
    {
      tool: [
        'mcp__meld__board',
        'mcp__meld__add_tasks',
        'mcp__meld__claim',
        'mcp__meld__release',
        'mcp__meld__finish_task',
        'mcp__meld__note',
        'mcp__meld__check',
        'mcp__meld__integrate',
        'mcp__meld__finish',
      ],
    },
    async ($, e) => {
      const io: Io = {
        run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
        now: () => $.clock.now(),
        sleep: ms => $.clock.sleep(ms),
        read: () => read($, runRef),
        write: change => update($, runRef, change),
        readFacts: () => read($, factsRef),
        writeFacts: facts => update($, factsRef, () => facts),
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
      return serveTool(io, e)
    },
  ).catch(($, e, next) => (next.called ? next(e) : { deny: 'meld: the board failed. Try the call again.' }))

  on('tool.call', async ($, e, next) => {
    if (String(e.tool).startsWith(MELD_TOOL)) return next(e)
    const io: Io = {
      run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
      now: () => $.clock.now(),
      sleep: ms => $.clock.sleep(ms),
      read: () => read($, runRef),
      write: change => update($, runRef, change),
      readFacts: () => read($, factsRef),
      writeFacts: facts => update($, factsRef, () => facts),
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

  on('turn.complete', async ($, e, next) => {
    const io: Io = {
      run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
      now: () => $.clock.now(),
      sleep: ms => $.clock.sleep(ms),
      read: () => read($, runRef),
      write: change => update($, runRef, change),
      readFacts: () => read($, factsRef),
      writeFacts: facts => update($, factsRef, () => facts),
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
    await markWorker(io, e.agentId, 'idle', tokensOf(e.usage))
    return completed
  })

  on('ui.render', { component: 'Pane', requestId: 'meld' }, async ($, e) => {
    const io: Io = {
      run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
      now: () => $.clock.now(),
      sleep: ms => $.clock.sleep(ms),
      read: () => read($, runRef),
      write: change => update($, runRef, change),
      readFacts: () => read($, factsRef),
      writeFacts: facts => update($, factsRef, () => facts),
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
      io,
      setView: change => update($, viewRef, view => change(view ?? DEFAULT_VIEW)),
      start: args => io.command('meld', args),
    })
  })
}
