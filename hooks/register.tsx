import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { bindAgent, claimSlot, guardCall, markWorker, serveTool, startRun, steerRun, stopAll } from './actions'
import { TOOL_SPECS } from './contract'
import type { Io } from './io'
import { PANE, paneTree } from './pane'

const MELD_TOOL = 'mcp__meld__'
// Change the shape tag when the fields of Run change: a value stored by an older version then reads as no run.
const runRef = atom({ plugin: 'meld', key: 'run' } as const, null, { shape: 'run-3' })
const PROCESS_TIMEOUT_MS = 120_000

let sessionCwd = ''

// Each hook builds its own Io below: a hooks module spells `$` only at its call sites, never passes it on.
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionCwd = e.cwd
    for (const spec of TOOL_SPECS) await $.tool.register(spec)
    await $.command.register({ name: 'meld', description: 'Start two workers on one task, each in its own git worktree', argumentHint: '<task>' })
    await $.command.register({ name: 'meld-steer', description: 'Give both meld workers a new instruction', argumentHint: '<instruction>', immediate: true })
    await $.command.register({ name: 'meld-status', description: 'Open the meld pane', immediate: true })
    await $.command.register({ name: 'meld-stop', description: 'Stop the meld workers; their branches stay', immediate: true })
    return next(e)
  })

  on('command.run', { command: ['meld', 'meld-steer', 'meld-status', 'meld-stop'] }, async ($, e) => {
    const io: Io = {
      run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
      now: () => $.clock.now(),
      sleep: ms => $.clock.sleep(ms),
      read: () => read($, runRef),
      write: change => update($, runRef, change),
      send: (agentId, text) => $.session.send({ to: { agentId }, text }),
      toast: text => $.ui.toast(text),
      openPane: focus => $.ui.open(focus ? { id: PANE, title: 'meld', focus: true } : { id: PANE, title: 'meld' }),
      submit: text => $.prompt.submit({ text }),
    }
    const args = e.args.trim()
    if (e.command === 'meld') return startRun(io, sessionCwd, args)
    if (e.command === 'meld-steer') return { text: await steerRun(io, args) }
    if (e.command === 'meld-stop') return { text: await stopAll(io) }
    await io.openPane(true)
    return { text: 'meld: the pane is open.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const io: Io = {
      run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
      now: () => $.clock.now(),
      sleep: ms => $.clock.sleep(ms),
      read: () => read($, runRef),
      write: change => update($, runRef, change),
      send: (agentId, text) => $.session.send({ to: { agentId }, text }),
      toast: text => $.ui.toast(text),
      openPane: focus => $.ui.open(focus ? { id: PANE, title: 'meld', focus: true } : { id: PANE, title: 'meld' }),
      submit: text => $.prompt.submit({ text }),
    }
    const worker = await claimSlot(io, e.fork, e.parentAgentId)
    if (!worker) return next(e)
    let agentId: string | undefined
    try {
      const started = await next({ ...e, cwd: worker.path, background: true })
      agentId = 'agentId' in started ? started.agentId : undefined
      return started
    } finally {
      await bindAgent(io, worker.id, agentId)
    }
  }).catch(($, e, next) => (next.called || !e.fork ? next(e) : { deny: 'meld: the spawn of a worker failed. Stop the run and start it again.' }))

  on('tool.call', async ($, e, next) => {
    const io: Io = {
      run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
      now: () => $.clock.now(),
      sleep: ms => $.clock.sleep(ms),
      read: () => read($, runRef),
      write: change => update($, runRef, change),
      send: (agentId, text) => $.session.send({ to: { agentId }, text }),
      toast: text => $.ui.toast(text),
      openPane: focus => $.ui.open(focus ? { id: PANE, title: 'meld', focus: true } : { id: PANE, title: 'meld' }),
      submit: text => $.prompt.submit({ text }),
    }
    if (String(e.tool).startsWith(MELD_TOOL)) return serveTool(io, e)
    const deny = await guardCall(io, e)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) =>
    next.called || !String(e.tool).startsWith(MELD_TOOL) ? next(e) : { deny: 'meld: the board failed. Try the call again.' },
  )

  on('turn.complete', async ($, e, next) => {
    const io: Io = {
      run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
      now: () => $.clock.now(),
      sleep: ms => $.clock.sleep(ms),
      read: () => read($, runRef),
      write: change => update($, runRef, change),
      send: (agentId, text) => $.session.send({ to: { agentId }, text }),
      toast: text => $.ui.toast(text),
      openPane: focus => $.ui.open(focus ? { id: PANE, title: 'meld', focus: true } : { id: PANE, title: 'meld' }),
      submit: text => $.prompt.submit({ text }),
    }
    const completed = await next(e)
    await markWorker(io, e.agentId, 'idle')
    return completed
  })

  on('ui.render', { component: 'Pane', requestId: 'meld' }, async ($, e) => {
    const io: Io = {
      run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: PROCESS_TIMEOUT_MS }),
      now: () => $.clock.now(),
      sleep: ms => $.clock.sleep(ms),
      read: () => read($, runRef),
      write: change => update($, runRef, change),
      send: (agentId, text) => $.session.send({ to: { agentId }, text }),
      toast: text => $.ui.toast(text),
      openPane: focus => $.ui.open(focus ? { id: PANE, title: 'meld', focus: true } : { id: PANE, title: 'meld' }),
      submit: text => $.prompt.submit({ text }),
    }
    return paneTree($.ui.resolve(e), e.surface, await read($, runRef), await $.clock.now(), io)
  })
}
