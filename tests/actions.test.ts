import { expect, test } from 'claude-code/testing'
import type { ToolCallInput } from 'claude-code'

import { deliver, discard, freshTokens, guardCall, markWorker, refreshFacts, restartIdleWorkers, serveTool, SPAWN_APPROVAL, spawnVerdict, startFromView, startRun, steerRun, stopOne } from '../hooks/actions'
import { addTasks, bindWorker, claimTask, declareFinal, isFailure, setActivity, startRun as startBoard, steer, takeIntegration } from '../hooks/board'
import { JJ_RESOLVE_TEMPLATE } from '../hooks/vcs'
import type { AgentSpec, Change, Run, VcsKind, WorkerId } from '../types'
import { FakeIo, HEAD } from './fake-io'

const NOW = 1_800_000_000_000
const ID = NOW.toString(36)
const FULL = 'f'.repeat(40)
const WORKER: AgentSpec = { type: 'meld:worker' }
const TWO = [WORKER, WORKER]

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

function working(count = 2, vcs: VcsKind = 'git'): Run {
  const ids = (['w1', 'w2', 'w3'] as WorkerId[]).slice(0, count)
  const workers = ids.map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: vcs === 'jj' ? `${id}@` : `meld/r1/${id}`, agent: WORKER }))
  let run = startBoard({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs, now: NOW, workers })
  for (const [index, id] of ids.entries()) run = runOf(bindWorker(run, id, `agent-${index + 1}`, NOW))
  return run
}

function ioWith(run: Run | null): FakeIo {
  const io = new FakeIo()
  io.current = run
  return io
}

const ASK = { decision: 'ask' }

test('meld approves its own spawn while its run lives', () => {
  expect(spawnVerdict(ASK, 'meld', working())).toEqual({ decision: 'allow', reason: SPAWN_APPROVAL })
})

test('the ask on a spawn of another plugin stands', () => {
  expect(spawnVerdict(ASK, 'other', working())).toBe(ASK)
})

test('the ask on a spawn with no run stands', () => {
  expect(spawnVerdict(ASK, 'meld', null)).toBe(ASK)
})

test('the ask on a spawn of a stopped run stands', () => {
  expect(spawnVerdict(ASK, 'meld', { ...working(), state: 'stopped' })).toBe(ASK)
})

test('a deny from a rule stands on a spawn of meld', () => {
  const deny = { decision: 'deny', reason: 'a rule' }
  expect(spawnVerdict(deny, 'meld', working())).toBe(deny)
})

function parsed(result: unknown): unknown {
  if (typeof result !== 'string') throw new Error(`a tool result is a string, not ${typeof result}`)
  return JSON.parse(result)
}

function call(input: Record<string, unknown>): ToolCallInput {
  return input as unknown as ToolCallInput
}

test('a run makes one workspace per worker and spawns each worker in its folder', async () => {
  const io = ioWith(null)
  const agents = [WORKER, { type: 'general-purpose', model: 'haiku' }, WORKER]
  const result = await startRun(io, '/repo/apps', { request: 'Add a dark theme', agents, vcs: 'auto' })
  expect(io.commands).toContain(`git worktree add -b meld/${ID}/w3 /tmp/meld/${ID}/w3 ${HEAD}`)
  expect(io.spawned.map(spawn => [spawn.description, spawn.subagentType, spawn.model, spawn.cwd])).toEqual([
    ['meld w1', 'meld:worker', undefined, `/tmp/meld/${ID}/w1`],
    ['meld w2', 'general-purpose', 'haiku', `/tmp/meld/${ID}/w2`],
    ['meld w3', 'meld:worker', undefined, `/tmp/meld/${ID}/w3`],
  ])
  expect(io.spawned[0]?.prompt).toContain('Add a dark theme')
  expect(io.current?.workers.map(worker => worker.agentId)).toEqual(['spawned-1', 'spawned-2', 'spawned-3'])
  expect(io.current?.state).toBe('working')
  expect(result.text).toBe(`Run ${ID}: 3 workers on git, from commit ${HEAD.slice(0, 7)}.`)
})

test('a run notes what the session has cost at its start', async () => {
  const io = ioWith(null)
  io.usd = 1.25
  await startRun(io, '/repo', { request: 'Add a dark theme', agents: TWO, vcs: 'auto' })
  expect(io.current?.costAtStart).toBe(1.25)
})

test('a turn counts the tokens it added, not the cached context it read again', () => {
  const usage = { model: 'sonnet', input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 1500 }
  expect(freshTokens(usage)).toBe(1710)
})

test('a run uses jj when jj is installed', async () => {
  const io = ioWith(null)
  io.answers['jj --version'] = 'jj 0.46.0'
  io.answers[`jj -R /tmp/meld/${ID}/jj config path --repo`] = '/root/.config/jj/repos/0123456789abcdef0123/config.toml'
  await startRun(io, '/repo', { request: 'Add a dark theme', agents: TWO, vcs: 'auto' })
  expect(io.current?.vcs).toBe('jj')
  expect(io.current?.workers.map(worker => worker.ref)).toEqual(['w1@', 'w2@'])
})

test('a run falls back to git when jj cannot make the workspaces', async () => {
  const io = ioWith(null)
  io.answers['jj --version'] = 'jj 0.46.0'
  io.failing = ['jj git init']
  const result = await startRun(io, '/repo', { request: 'Add a dark theme', agents: TWO, vcs: 'auto' })
  expect(io.current?.vcs).toBe('git')
  expect(result.text).toContain('jj failed (jj: failed), so the workers use git.')
})

test('a run on jj stops when jj is not installed', async () => {
  const io = ioWith(null)
  io.missing = ['jj']
  const result = await startRun(io, '/repo', { request: 'Add a dark theme', agents: TWO, vcs: 'jj' })
  expect(result.text).toBe('jj 0.40 or newer is not installed. Use --vcs git or --vcs auto.')
  expect(io.current).toBeNull()
})

test('a worker whose spawn is refused is stopped, and the run says why', async () => {
  const io = ioWith(null)
  io.spawnDeny = 'the host limit'
  const result = await startRun(io, '/repo', { request: 'Add a dark theme', agents: TWO, vcs: 'git' })
  expect(io.current?.workers.map(worker => worker.state)).toEqual(['stopped', 'stopped'])
  expect(io.current?.state).toBe('stopped')
  expect(result.text).toContain('No worker started: the host limit')
})

test('a run of three works when the third spawn is refused, and says why one did not start', async () => {
  const io = ioWith(null)
  io.spawnDenies['meld w3'] = 'the host limit'
  const result = await startRun(io, '/repo', { request: 'Add a dark theme', agents: [WORKER, WORKER, WORKER], vcs: 'git' })
  expect(io.current?.state).toBe('working')
  expect(io.current?.workers.map(worker => [worker.id, worker.state, worker.agentId])).toEqual([
    ['w1', 'working', 'spawned-1'],
    ['w2', 'working', 'spawned-2'],
    ['w3', 'stopped', undefined],
  ])
  expect(io.current?.workers[2]?.activity).toBe('not started: the host limit')
  expect(io.current?.log.map(entry => entry.text)).toContain('w3 did not start: the host limit')
  expect(result.text).toBe(`Run ${ID}: 3 workers on git, from commit ${HEAD.slice(0, 7)}. 1 did not start: the host limit.`)
})

test('a worker whose spawn was refused does not start again, and a worker that started leads', async () => {
  const io = ioWith(null)
  io.spawnDenies['meld w1'] = 'the host limit'
  await startRun(io, '/repo', { request: 'Add a dark theme', agents: [WORKER, WORKER, WORKER], vcs: 'git' })
  await markWorker(io, 'spawned-2', 'idle')
  await markWorker(io, 'spawned-3', 'idle')
  await restartIdleWorkers(io)
  expect(io.current?.workers.map(worker => worker.agentId)).toEqual([undefined, 'spawned-4', 'spawned-3'])
  expect(io.spawned[3]?.prompt).toContain('There are no tasks yet')
})

test('a run starts in another repository when the request begins with its path', async () => {
  const io = ioWith(null)
  await startRun(io, '/repo', { request: '/elsewhere Add a dark theme', agents: TWO, vcs: 'git' })
  expect(io.current?.request).toBe('Add a dark theme')
  expect(io.current?.repo).toBe('/elsewhere')
})

test('a request that begins with a slash but names no repository stays whole', async () => {
  const io = ioWith(null)
  await startRun(io, '/repo', { request: '/api routes need tests', agents: TWO, vcs: 'git' })
  expect(io.current?.request).toBe('/api routes need tests')
  expect(io.current?.repo).toBe('/repo')
})

test('a run does not start outside a git repository', async () => {
  const io = ioWith(null)
  io.repos = []
  expect((await startRun(io, '/tmp', { request: 'Add a dark theme', agents: TWO, vcs: 'git' })).text).toBe(
    'meld needs a git repository in the working directory.',
  )
  expect(io.current).toBeNull()
})

test('a second run waits until the first one ends', async () => {
  const io = ioWith(working())
  expect((await startRun(io, '/repo', { request: 'More', agents: TWO, vcs: 'git' })).text).toBe(
    'A run is active. Deliver, discard or stop it in the meld pane first.',
  )
})

test('an edit of a worker outside its worktree is refused with the path inside it', async () => {
  const io = ioWith(working())
  const deny = await guardCall(io, call({ tool: 'Edit', file_path: '/repo/src/a.ts', agentId: 'agent-1' }))
  expect(deny).toBe('meld: you work in /tmp/meld/r1/w1. Edit /tmp/meld/r1/w1/src/a.ts instead.')
})

test('an edit of a worker inside its worktree goes on and shows as its activity', async () => {
  const io = ioWith(working())
  expect(await guardCall(io, call({ tool: 'Edit', file_path: '/tmp/meld/r1/w1/src/a.ts', agentId: 'agent-1' }))).toBeUndefined()
  expect(io.current?.workers[0]?.activity).toBe('Edit a.ts')
})

test('a stopped worker may hand back, which ends its turn', async () => {
  const io = ioWith(working())
  await stopOne(io, 'w1')
  expect(await guardCall(io, call({ tool: 'SubagentHandback', message: 'Stopped.', agentId: 'agent-1' }))).toBeUndefined()
})

test('a worker of a ready run may hand back, and may do no other work', async () => {
  const io = ioWith(runOf(declareFinal(runOf(takeIntegration(working(), 'w2', NOW)), 'w2', FULL, 'Done', NOW)))
  expect(await guardCall(io, call({ tool: 'SubagentHandback', message: 'Done.', agentId: 'agent-2' }))).toBeUndefined()
  expect(await guardCall(io, call({ tool: 'Bash', command: 'ls', agentId: 'agent-2' }))).toBe('The meld run has its final commit. End your turn now.')
})

test('a tool call of the main session is never guarded', async () => {
  const io = ioWith(working())
  expect(await guardCall(io, call({ tool: 'Edit', file_path: '/repo/src/a.ts' }))).toBeUndefined()
})

test('a stopped worker is told to end its turn', async () => {
  const io = ioWith(working())
  await stopOne(io, 'w1')
  expect(await guardCall(io, call({ tool: 'Bash', command: 'ls', agentId: 'agent-1' }))).toBe('meld stopped you. End your turn now with a one-line summary.')
  expect(io.sent).toContain('agent-1: meld stopped you. End your turn now.')
})

test('the first board read of a worker carries its rules, and the next one does not', async () => {
  const io = ioWith(working())
  const first = parsed((await serveTool(io, call({ tool: 'mcp__meld__board', agentId: 'agent-2' }))).result) as { rules?: string }
  expect(first.rules).toContain('You are w2')
  const second = parsed((await serveTool(io, call({ tool: 'mcp__meld__board', agentId: 'agent-2' }))).result) as { rules?: string }
  expect(second.rules).toBeUndefined()
})

test('a board call of a worker answers with the steer it has not seen', async () => {
  const io = ioWith(runOf(steer(runOf(addTasks(working(), 'w1', { seen: 0, tasks: [{ title: 'Tokens' }] }, NOW)), 'Use the brand colours', NOW)))
  const replied = await serveTool(io, call({ tool: 'mcp__meld__claim', task: 1, version: 1, agentId: 'agent-2' }))
  expect(parsed(replied.result)).toMatchObject({ ok: true, notice: { revision: 2, steers: ['Use the brand colours'] } })
})

test('the meld tools refuse an agent that is not a worker', async () => {
  const io = ioWith(working())
  const replied = await serveTool(io, call({ tool: 'mcp__meld__add_tasks', seen: 0, tasks: [{ title: 'Tokens' }], agentId: 'agent-9' }))
  expect(parsed(replied.result)).toMatchObject({ error: 'NOT_WORKER' })
})

test('a share answers with its entry and the context, newest first', async () => {
  const io = ioWith(working())
  await serveTool(io, call({ tool: 'mcp__meld__share', kind: 'fact', text: 'The tokens are in src/theme.css.', files: ['src/theme.css'], agentId: 'agent-1' }))
  const replied = await serveTool(io, call({ tool: 'mcp__meld__share', kind: 'fail', text: 'jj split opens an editor, and the call hangs.', agentId: 'agent-1' }))
  expect(parsed(replied.result)).toMatchObject({
    ok: true,
    value: { kind: 'fail', by: 'w1' },
    context: [
      { kind: 'fail', by: 'w1', text: 'jj split opens an editor, and the call hangs.', files: [], seenBy: [] },
      { kind: 'fact', by: 'w1', text: 'The tokens are in src/theme.css.', files: ['src/theme.css'], seenBy: [] },
    ],
  })
})

test('a share that replaces an older entry takes that entry out of the context', async () => {
  const io = ioWith(working())
  const first = parsed((await serveTool(io, call({ tool: 'mcp__meld__share', kind: 'fact', text: 'add() is in src/math.js.', agentId: 'agent-1' }))).result) as { value: { id: number } }
  const replied = await serveTool(io, call({ tool: 'mcp__meld__share', kind: 'fact', text: 'add() is in src/sum.js.', replaces: first.value.id, agentId: 'agent-2' }))
  expect(parsed(replied.result)).toMatchObject({ ok: true, context: [{ by: 'w2', text: 'add() is in src/sum.js.', replaces: first.value.id }] })
  expect((parsed(replied.result) as { context: unknown[] }).context).toHaveLength(1)
})

test('each board tool reply of a worker carries the context, and the entries it carries list that worker in seenBy', async () => {
  const io = ioWith(runOf(addTasks(working(), 'w1', { seen: 0, tasks: [{ title: 'Tokens' }] }, NOW)))
  await serveTool(io, call({ tool: 'mcp__meld__share', kind: 'interface', text: 'tokens(): Record<string, string> in src/theme.ts', agentId: 'agent-1' }))
  const replied = await serveTool(io, call({ tool: 'mcp__meld__claim', task: 1, version: 1, agentId: 'agent-2' }))
  expect(parsed(replied.result)).toMatchObject({ ok: true, context: [{ kind: 'interface', by: 'w1', seenBy: ['w2'] }] })
  expect(io.current?.context?.[0]?.seenBy).toEqual(['w2'])
})

test('a refused board call of a worker carries the context', async () => {
  const io = ioWith(working())
  await serveTool(io, call({ tool: 'mcp__meld__share', kind: 'fail', text: 'jj split opens an editor, and the call hangs.', agentId: 'agent-1' }))
  const replied = await serveTool(io, call({ tool: 'mcp__meld__claim', task: 9, version: 1, agentId: 'agent-2' }))
  expect(parsed(replied.result)).toMatchObject({ error: 'NOT_FOUND', context: [{ kind: 'fail', seenBy: ['w2'] }] })
})

test('a board read of a worker carries the context', async () => {
  const io = ioWith(working())
  await serveTool(io, call({ tool: 'mcp__meld__share', kind: 'fact', text: 'The tokens are in src/theme.css.', agentId: 'agent-1' }))
  const view = parsed((await serveTool(io, call({ tool: 'mcp__meld__board', agentId: 'agent-2' }))).result)
  expect(view).toMatchObject({ context: [{ kind: 'fact', by: 'w1', text: 'The tokens are in src/theme.css.', seenBy: ['w2'] }] })
})

test('the board read of the main session carries the context, and adds no reader to seenBy', async () => {
  const io = ioWith(working())
  await serveTool(io, call({ tool: 'mcp__meld__share', kind: 'fact', text: 'The tokens are in src/theme.css.', agentId: 'agent-1' }))
  const view = parsed((await serveTool(io, call({ tool: 'mcp__meld__board' }))).result)
  expect(view).toMatchObject({ context: [{ kind: 'fact', by: 'w1', seenBy: [] }] })
  expect(io.current?.context?.[0]?.seenBy).toEqual([])
})

test('the commit of a share is kept as the full id that its revision names in the folder of the worker', async () => {
  const io = ioWith(working())
  io.answers['git rev-parse --verify --quiet HEAD^{commit}'] = FULL
  await serveTool(io, call({ tool: 'mcp__meld__share', kind: 'fact', text: 'add() is in src/math.js.', commit: 'HEAD', agentId: 'agent-1' }))
  expect(io.current?.context?.[0]?.commit).toBe(FULL)
  expect(io.cwds['git rev-parse --verify --quiet HEAD^{commit}']).toBe('/tmp/meld/r1/w1')
})

test('a share with a commit that does not exist is refused, and its reply carries the context', async () => {
  const io = ioWith(working())
  io.failing = ['git rev-parse --verify']
  const replied = await serveTool(io, call({ tool: 'mcp__meld__share', kind: 'fact', text: 'add() is in src/math.js.', commit: 'fff0000', agentId: 'agent-1' }))
  expect(parsed(replied.result)).toMatchObject({ error: 'NOT_FOUND', context: [] })
  expect(io.current?.context).toEqual([])
})

test('a share with no commit asks the version control nothing', async () => {
  const io = ioWith(working())
  await serveTool(io, call({ tool: 'mcp__meld__share', kind: 'fact', text: 'add() is in src/math.js.', agentId: 'agent-1' }))
  expect(io.commands).toEqual([])
})

test('finish_task shows its interfaces and the work it left in the context, with the commit of the task', async () => {
  const io = ioWith(runOf(claimTask(runOf(addTasks(working(), 'w1', { seen: 0, tasks: [{ title: 'Tokens' }] }, NOW)), 'w1', 1, 1, NOW)))
  io.answers['git rev-parse --verify --quiet HEAD^{commit}'] = FULL
  const done = { task: 1, version: 2, commit: 'HEAD', summary: 'Tokens in src/theme.ts', interfaces: 'tokens(): Record<string, string>', unfinished: 'The dark values' }
  const replied = await serveTool(io, call({ tool: 'mcp__meld__finish_task', ...done, agentId: 'agent-1' }))
  expect(parsed(replied.result)).toMatchObject({
    ok: true,
    context: [
      { kind: 'fact', by: 'w1', text: '#1 unfinished: The dark values', commit: FULL },
      { kind: 'interface', by: 'w1', text: '#1: tokens(): Record<string, string>', commit: FULL },
    ],
  })
})

test('a final commit that does not exist is refused', async () => {
  const io = ioWith(runOf(takeIntegration(working(), 'w2', NOW)))
  io.failing = ['git rev-parse --verify']
  const replied = await serveTool(io, call({ tool: 'mcp__meld__finish', commit: 'fff0000', summary: 'Done', agentId: 'agent-2' }))
  expect(parsed(replied.result)).toMatchObject({ error: 'NOT_FOUND' })
  expect(io.current?.state).toBe('working')
})

test('a final commit is kept as the full id that its revision names in the folder of the worker', async () => {
  const io = ioWith(runOf(takeIntegration(working(), 'w2', NOW)))
  io.answers['git rev-parse --verify --quiet HEAD^{commit}'] = FULL
  await serveTool(io, call({ tool: 'mcp__meld__finish', commit: 'HEAD', summary: 'Done', agentId: 'agent-2' }))
  expect(io.current?.final?.commit).toBe(FULL)
  expect(io.cwds['git rev-parse --verify --quiet HEAD^{commit}']).toBe('/tmp/meld/r1/w2')
})

test('a final commit with a conflict is refused', async () => {
  const io = ioWith(runOf(takeIntegration(working(2, 'jj'), 'w2', NOW)))
  io.answers[`jj -R /tmp/meld/r1/w2 --ignore-working-copy log --no-graph -r @- -T ${JJ_RESOLVE_TEMPLATE}`] = `${FULL} conflict`
  const replied = await serveTool(io, call({ tool: 'mcp__meld__finish', commit: '@-', summary: 'Done', agentId: 'agent-2' }))
  expect(parsed(replied.result)).toMatchObject({ error: 'CONFLICT' })
  expect(io.current?.state).toBe('working')
})

test('a final commit tells the other workers to stop and the person that the result is ready', async () => {
  const io = ioWith(runOf(takeIntegration(working(3), 'w2', NOW)))
  io.answers['git rev-parse --verify --quiet fff0000^{commit}'] = FULL
  await serveTool(io, call({ tool: 'mcp__meld__finish', commit: 'fff0000', summary: 'Done', agentId: 'agent-2' }))
  expect(io.current?.state).toBe('ready')
  expect(io.sent).toEqual(['agent-1: The final commit is declared. End your turn now.', 'agent-3: The final commit is declared. End your turn now.'])
  expect(io.toasts).toContain('meld: the result is ready. Deliver it from the meld pane.')
})

test('a steer reaches every live worker', async () => {
  const io = ioWith(working(3))
  expect(await steerRun(io, 'Use the brand colours')).toBe('All 3 workers get revision 2.')
  expect(io.sent).toHaveLength(3)
})

test('the end of the last turn starts no agent; the next beat of the clock does', async () => {
  const io = ioWith(runOf(takeIntegration(working(), 'w2', NOW)))
  await markWorker(io, 'agent-1', 'idle')
  await markWorker(io, 'agent-2', 'idle')
  expect(io.spawned).toHaveLength(0)
  await restartIdleWorkers(io)
  expect(io.spawned).toHaveLength(1)
})

test('when every worker has ended and every task is done, meld starts the integrator again in its folder', async () => {
  const io = ioWith(runOf(takeIntegration(working(), 'w2', NOW)))
  await markWorker(io, 'agent-1', 'idle')
  await markWorker(io, 'agent-2', 'idle')
  await restartIdleWorkers(io)
  expect(io.sent).toHaveLength(0)
  expect(io.spawned.map(spawn => [spawn.description, spawn.cwd])).toEqual([['meld w2', '/tmp/meld/r1/w2']])
  expect(io.spawned[0]?.prompt).toContain('All tasks are done. Integrate')
  expect(io.current?.workers[1]).toMatchObject({ agentId: 'spawned-1', state: 'working', briefed: false })
})

test('when every worker has ended with open tasks, meld starts one worker for each open task, owners first', async () => {
  const planned = runOf(addTasks(working(3), 'w1', { seen: 0, tasks: [{ title: 'Tokens' }, { title: 'Docs' }] }, NOW))
  const io = ioWith(runOf(claimTask(planned, 'w3', 2, 1, NOW)))
  await markWorker(io, 'agent-1', 'idle')
  await markWorker(io, 'agent-2', 'idle')
  await markWorker(io, 'agent-3', 'idle')
  await restartIdleWorkers(io)
  expect(io.spawned.map(spawn => spawn.description)).toEqual(['meld w3', 'meld w1'])
  expect(io.spawned[0]?.prompt).toContain('Your task is not done: #2 Docs')
  expect(io.spawned[1]?.prompt).toContain('These tasks are open: #1 Tokens')
})

test('a worker that ended starts again when a working peer adds tasks', async () => {
  const io = ioWith(working(3))
  await markWorker(io, 'agent-2', 'idle')
  await markWorker(io, 'agent-3', 'idle')
  await serveTool(io, call({ tool: 'mcp__meld__add_tasks', seen: 0, tasks: [{ title: 'Tokens' }, { title: 'Docs' }], agentId: 'agent-1' }))
  await restartIdleWorkers(io)
  expect(io.spawned.map(spawn => spawn.description)).toEqual(['meld w2', 'meld w3'])
  expect(io.spawned[0]?.prompt).toContain('These tasks are open: #1 Tokens; #2 Docs')
})

test('a worker that ended after it read the board stays idle until there is news', async () => {
  const io = ioWith(working(3))
  await serveTool(io, call({ tool: 'mcp__meld__add_tasks', seen: 0, tasks: [{ title: 'Tokens' }, { title: 'Docs' }], agentId: 'agent-1' }))
  await serveTool(io, call({ tool: 'mcp__meld__board', agentId: 'agent-2' }))
  await markWorker(io, 'agent-2', 'idle')
  await restartIdleWorkers(io)
  expect(io.spawned).toHaveLength(0)
  await serveTool(io, call({ tool: 'mcp__meld__note', text: 'The tokens are in theme.css', agentId: 'agent-1' }))
  await restartIdleWorkers(io)
  expect(io.spawned.map(spawn => spawn.description)).toEqual(['meld w2'])
})

test('with no tasks and every worker ended, the lead splits the request', async () => {
  const io = ioWith(working())
  await markWorker(io, 'agent-1', 'idle')
  await markWorker(io, 'agent-2', 'idle')
  await restartIdleWorkers(io)
  expect(io.spawned.map(spawn => spawn.description)).toEqual(['meld w1'])
  expect(io.spawned[0]?.prompt).toContain('There are no tasks yet')
})

test('two beats at the same time start one agent for a worker', async () => {
  const io = ioWith(runOf(takeIntegration(working(), 'w2', NOW)))
  await markWorker(io, 'agent-1', 'idle')
  await markWorker(io, 'agent-2', 'idle')
  await Promise.all([restartIdleWorkers(io), restartIdleWorkers(io)])
  expect(io.spawned).toHaveLength(1)
})

test('a beat counts a working worker whose agent the engine lists as ended as idle', async () => {
  const io = ioWith(runOf(takeIntegration(working(), 'w2', NOW)))
  io.agentStates = new Map([['agent-1', 'ended'], ['agent-2', 'ended']])
  await restartIdleWorkers(io)
  expect(io.current?.workers[0]?.state).toBe('idle')
  expect(io.spawned.map(spawn => spawn.description)).toEqual(['meld w2'])
})

test('a beat counts a working worker whose agent the engine no longer lists as idle, after a grace', async () => {
  const stale = setActivity(setActivity(runOf(takeIntegration(working(), 'w2', NOW)), 'w1', 'Bash: pnpm test', NOW - 60_000), 'w2', 'Bash: jj new', NOW - 60_000)
  const io = ioWith(stale)
  io.agentStates = new Map()
  await restartIdleWorkers(io)
  expect(io.spawned.map(spawn => spawn.description)).toEqual(['meld w2'])
})

test('a beat leaves a working worker alone while the engine runs its agent', async () => {
  const io = ioWith(setActivity(runOf(takeIntegration(working(), 'w2', NOW)), 'w1', 'Bash: pnpm test', NOW - 60_000))
  io.agentStates = new Map([['agent-1', 'live'], ['agent-2', 'live']])
  await restartIdleWorkers(io)
  expect(io.current?.workers.map(worker => worker.state)).toEqual(['working', 'working'])
  expect(io.spawned).toHaveLength(0)
})

test('a beat does not count a worker that just started as ended before the engine lists its agent', async () => {
  const io = ioWith(runOf(takeIntegration(working(), 'w2', NOW)))
  io.agentStates = new Map()
  await restartIdleWorkers(io)
  expect(io.current?.workers.map(worker => worker.state)).toEqual(['working', 'working'])
})

test('the pane form starts a run with its task, number of agents, model and version control', async () => {
  const io = ioWith(null)
  const text = await startFromView(io, '/repo', { showDiff: false, task: 'Add a dark theme', agents: 3, model: 'haiku', vcs: 'git' })
  expect(io.spawned.map(spawn => [spawn.description, spawn.model])).toEqual([['meld w1', 'haiku'], ['meld w2', 'haiku'], ['meld w3', 'haiku']])
  expect(text).toBe(`Run ${ID}: 3 workers on git, from commit ${HEAD.slice(0, 7)}.`)
})

test('the pane form asks for the task first', async () => {
  expect(await startFromView(ioWith(null), '/repo', { showDiff: false, task: '  ', agents: 2, model: 'inherit', vcs: 'auto' })).toBe('Write the task first.')
})

test('a beat with one worker still working starts no agent', async () => {
  const io = ioWith(working())
  await markWorker(io, 'agent-1', 'idle')
  await restartIdleWorkers(io)
  expect(io.spawned).toHaveLength(0)
})

test('a worker that meld starts again gets its rules again on its first board read', async () => {
  const io = ioWith(runOf(takeIntegration(working(), 'w2', NOW)))
  await markWorker(io, 'agent-1', 'idle')
  await markWorker(io, 'agent-2', 'idle')
  await restartIdleWorkers(io)
  const first = parsed((await serveTool(io, call({ tool: 'mcp__meld__board', agentId: 'spawned-1' }))).result) as { rules?: string }
  expect(first.rules).toContain('You are w2')
})

test('the end of an agent that meld replaced changes nothing', async () => {
  const io = ioWith(runOf(takeIntegration(working(), 'w2', NOW)))
  await markWorker(io, 'agent-1', 'idle')
  await markWorker(io, 'agent-2', 'idle')
  await restartIdleWorkers(io)
  await markWorker(io, 'agent-2', 'idle')
  await restartIdleWorkers(io)
  expect(io.spawned).toHaveLength(1)
  expect(io.current?.workers[1]?.state).toBe('working')
})

test('after three restarts that finish nothing the person is told once to steer, and a steer allows new restarts', async () => {
  const io = ioWith(working())
  await markWorker(io, 'agent-1', 'idle')
  await markWorker(io, 'agent-2', 'idle')
  await restartIdleWorkers(io)
  await markWorker(io, 'spawned-1', 'idle')
  await restartIdleWorkers(io)
  await markWorker(io, 'spawned-2', 'idle')
  await restartIdleWorkers(io)
  await markWorker(io, 'spawned-3', 'idle')
  await restartIdleWorkers(io)
  await restartIdleWorkers(io)
  expect(io.spawned).toHaveLength(3)
  expect(io.toasts).toEqual(['meld: three restarts in a row finished no task. Steer the workers or stop the run.'])
  expect(await steerRun(io, 'Add the docs')).toBe('Revision 2: meld starts w1 again with it.')
  expect(io.spawned[3]?.prompt).toContain('Add the docs')
})

test('a steer of a ready run starts the integrator again with the steer', async () => {
  const io = ioWith(runOf(declareFinal(runOf(takeIntegration(working(), 'w2', NOW)), 'w2', FULL, 'Done', NOW)))
  await markWorker(io, 'agent-1', 'idle')
  await markWorker(io, 'agent-2', 'idle')
  expect(await steerRun(io, 'Rename the toggle')).toBe('Revision 2: meld starts w2 again with it.')
  expect(io.spawned.map(spawn => spawn.description)).toEqual(['meld w2'])
  expect(io.spawned[0]?.prompt).toContain('The person changed the request (revision 2): Rename the toggle')
  expect(io.spawned[0]?.prompt).not.toContain('All tasks are done')
})

test('a steer goes as a message to the running workers, and waits for the ended ones', async () => {
  const io = ioWith(working(3))
  await markWorker(io, 'agent-2', 'idle')
  expect(await steerRun(io, 'Use the brand colours')).toBe('Revision 2: 2 running workers get it; the others see it when meld starts them again.')
  expect(io.sent.map(message => message.split(':')[0])).toEqual(['agent-1', 'agent-3'])
  expect(io.spawned).toHaveLength(0)
})

test('the main session steers the run with the steer tool', async () => {
  const io = ioWith(working(3))
  const replied = await serveTool(io, call({ tool: 'mcp__meld__steer', text: 'Integrate now' }))
  expect(parsed(replied.result)).toEqual({ text: 'All 3 workers get revision 2.' })
})

test('a restart skips a stopped worker and offers the task that it had claimed', async () => {
  const planned = runOf(addTasks(working(3), 'w1', { seen: 0, tasks: [{ title: 'Tokens' }, { title: 'Docs' }] }, NOW))
  const io = ioWith(runOf(claimTask(planned, 'w2', 1, 1, NOW)))
  await stopOne(io, 'w2')
  await markWorker(io, 'agent-1', 'idle')
  await markWorker(io, 'agent-2', 'idle')
  await markWorker(io, 'agent-3', 'idle')
  await restartIdleWorkers(io)
  expect(io.spawned.map(spawn => spawn.description)).toEqual(['meld w1', 'meld w3'])
  expect(io.spawned[0]?.prompt).toContain('These tasks are open: #1 Tokens; #2 Docs')
})

test('when the integrator is stopped, a live worker starts again to lead', async () => {
  const io = ioWith(runOf(takeIntegration(working(3), 'w1', NOW)))
  await stopOne(io, 'w1')
  await markWorker(io, 'agent-2', 'idle')
  await markWorker(io, 'agent-3', 'idle')
  await restartIdleWorkers(io)
  expect(io.current?.integrator).toBeUndefined()
  expect(io.spawned.map(spawn => spawn.description)).toEqual(['meld w2'])
})

test('a stopped worker stays stopped when its turn ends, and no restart comes while a live worker works', async () => {
  const io = ioWith(working(3))
  await stopOne(io, 'w2')
  await markWorker(io, 'agent-1', 'idle')
  await markWorker(io, 'agent-2', 'idle')
  await restartIdleWorkers(io)
  expect(io.current?.workers.map(worker => worker.state)).toEqual(['idle', 'stopped', 'working'])
  expect(io.spawned).toHaveLength(0)
})

test('the tokens of each turn add up on the worker', async () => {
  const io = ioWith(working())
  await markWorker(io, 'agent-2', 'idle', 1500)
  await markWorker(io, 'agent-2', 'idle', 500)
  expect(io.current?.workers[1]?.tokens).toBe(2000)
})

test('deliver refuses a checkout with uncommitted changes', async () => {
  const io = ioWith(runOf(declareFinal(runOf(takeIntegration(working(), 'w2', NOW)), 'w2', FULL, 'Done', NOW)))
  io.dirty = true
  expect(await deliver(io)).toBe('Commit or stash the changes in your checkout first, then deliver.')
  expect(io.ran('git merge')).toBe(false)
})

test('deliver merges the final commit, then removes the workspaces', async () => {
  const io = ioWith(runOf(declareFinal(runOf(takeIntegration(working(), 'w2', NOW)), 'w2', FULL, 'Done', NOW)))
  expect(await deliver(io)).toBe(`Merged ${FULL.slice(0, 7)} into your branch.`)
  expect(io.commands).toContain(`git merge --no-ff -m meld: Add a dark theme ${FULL}`)
  expect(io.commands).toContain('git worktree remove --force /tmp/meld/r1/w2')
  expect(io.current?.state).toBe('delivered')
})

test('discard removes the run and its folder', async () => {
  const io = ioWith(working())
  expect(await discard(io)).toBe('The run and its workspaces are gone.')
  expect(io.commands).toContain('rm -rf -- /tmp/meld/r1')
  expect(io.current).toBeNull()
})

test('a board read from the main session is a string the model can read', async () => {
  const io = ioWith(working(3))
  const view = parsed((await serveTool(io, call({ tool: 'mcp__meld__board' }))).result)
  expect(view).toMatchObject({ id: 'r1', vcs: 'git', state: 'working', workers: [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }] })
})

test('a stale add from a worker answers with the tasks of the other worker', async () => {
  const io = ioWith(working())
  await serveTool(io, call({ tool: 'mcp__meld__add_tasks', seen: 0, tasks: [{ title: 'src/math.js: add and multiply' }], agentId: 'agent-1' }))
  const replied = await serveTool(io, call({ tool: 'mcp__meld__add_tasks', seen: 0, tasks: [{ title: 'src/math.js: export add and multiply' }], agentId: 'agent-2' }))
  expect(parsed(replied.result)).toMatchObject({ error: 'STALE_TASK_LIST', taskList: 1, tasks: [{ id: 1, title: 'src/math.js: add and multiply' }] })
  expect(io.current?.tasks).toHaveLength(1)
})

test('facts show the commits of each worker, and the change of a ready run', async () => {
  const io = ioWith(runOf(declareFinal(runOf(takeIntegration(working(), 'w2', NOW)), 'w2', FULL, 'Done', NOW)))
  io.answers[`git log --format=%H%x09%P%x09%s -n 40 ${HEAD}..meld/r1/w2`] = `${FULL}\t${HEAD}\tAdd add()`
  io.answers[`git diff --no-renames --numstat ${HEAD} ${FULL}`] = '2\t0\tsrc/math.js'
  await refreshFacts(io)
  expect(io.facts?.lanes.map(lane => lane.commits.length)).toEqual([0, 1])
  expect(io.facts?.result).toMatchObject({ commit: FULL, fileCount: 1, added: 2 })
})

test('the start tool starts a run of the workers it names, in the folder of the session', async () => {
  const io = ioWith(null)
  const replied = await serveTool(io, call({ tool: 'mcp__meld__start', request: 'Add a dark theme', agents: 'opus,Explore,haiku', vcs: 'git' }), '/repo')
  expect(parsed(replied.result)).toEqual({ text: `Run ${ID}: 3 workers on git, from commit ${HEAD.slice(0, 7)}.` })
  expect(io.spawned.map(spawn => [spawn.subagentType, spawn.model])).toEqual([['meld:worker', 'opus'], ['Explore', undefined], ['meld:worker', 'haiku']])
})

test('the start tool with the model inherit spawns each worker with no model', async () => {
  const io = ioWith(null)
  await serveTool(io, call({ tool: 'mcp__meld__start', request: 'Add a dark theme', agents: '2', model: 'inherit', vcs: 'git' }), '/repo')
  expect(io.spawned.map(spawn => [spawn.subagentType, spawn.model])).toEqual([['meld:worker', undefined], ['meld:worker', undefined]])
  expect(io.current?.workers.map(worker => worker.agent)).toStrictEqual([{ type: 'meld:worker' }, { type: 'meld:worker' }])
})

test('the start tool refuses options that /meld refuses', async () => {
  const io = ioWith(null)
  const replied = await serveTool(io, call({ tool: 'mcp__meld__start', request: 'Add a dark theme', agents: '12' }))
  expect(parsed(replied.result)).toEqual({ error: 'meld runs 1 to 8 workers.' })
  expect(io.current).toBeNull()
})

test('a worker cannot start a run', async () => {
  const io = ioWith(working())
  const replied = await serveTool(io, call({ tool: 'mcp__meld__start', request: 'More', agentId: 'agent-1' }))
  expect(parsed(replied.result)).toMatchObject({ error: 'NOT_ALLOWED' })
})

test('the main session stops a run with the stop tool', async () => {
  const io = ioWith(working())
  const replied = await serveTool(io, call({ tool: 'mcp__meld__stop' }))
  expect(parsed(replied.result)).toEqual({ text: 'Stopped. The workspaces stay until you discard them in the meld pane.' })
  expect(io.current?.state).toBe('stopped')
})

test('a worker cannot stop the run', async () => {
  const io = ioWith(working())
  const replied = await serveTool(io, call({ tool: 'mcp__meld__stop', agentId: 'agent-2' }))
  expect(parsed(replied.result)).toMatchObject({ error: 'NOT_ALLOWED' })
  expect(io.current?.state).toBe('working')
})

test('a Bash call shows the command after a leading cd as the activity', async () => {
  const io = ioWith(working())
  await guardCall(io, call({ tool: 'Bash', command: 'cd /tmp/meld/r1/w1 && cd src && jj log -r @', agentId: 'agent-1' }))
  expect(io.current?.workers[0]?.activity).toBe('Bash: jj log -r @')
})

test('each tool call of a worker counts, the board tools too', async () => {
  const io = ioWith(working())
  await guardCall(io, call({ tool: 'Read', file_path: '/tmp/meld/r1/w2/README.md', agentId: 'agent-2' }))
  await guardCall(io, call({ tool: 'Bash', command: 'ls', agentId: 'agent-2' }))
  await serveTool(io, call({ tool: 'mcp__meld__board', agentId: 'agent-2' }))
  expect(io.current?.workers.map(worker => worker.calls)).toEqual([0, 3])
})

const BOARD_FILE = '/tmp/meld/r1/board.json'

function mirrorOf(io: FakeIo, path = BOARD_FILE): Run | undefined {
  const text = io.files[path]
  return text === undefined ? undefined : (JSON.parse(text) as Run)
}

test('a new run mirrors its board to board.json in the folder of the run', async () => {
  const io = ioWith(null)
  await startRun(io, '/repo', { request: 'Add a dark theme', agents: TWO, vcs: 'git' })
  expect(mirrorOf(io, `/tmp/meld/${ID}/board.json`)).toEqual(io.current ?? undefined)
})

test('a share mirrors the board with its context', async () => {
  const io = ioWith(working())
  await serveTool(io, call({ tool: 'mcp__meld__share', kind: 'fact', text: 'The tokens are in src/theme.css.', agentId: 'agent-1' }))
  expect(mirrorOf(io)?.context?.map(entry => [entry.kind, entry.by, entry.text])).toEqual([['fact', 'w1', 'The tokens are in src/theme.css.']])
})

test('the mirror holds the board of the newest write', async () => {
  const io = ioWith(working())
  await serveTool(io, call({ tool: 'mcp__meld__share', kind: 'fact', text: 'The tokens are in src/theme.css.', agentId: 'agent-1' }))
  await serveTool(io, call({ tool: 'mcp__meld__board', agentId: 'agent-2' }))
  expect(mirrorOf(io)?.context?.[0]?.seenBy).toEqual(['w2'])
  expect(mirrorOf(io)).toEqual(io.current ?? undefined)
})

test('a guarded tool call and a steer mirror the board', async () => {
  const io = ioWith(working())
  await guardCall(io, call({ tool: 'Bash', command: 'pnpm test', agentId: 'agent-1' }))
  expect(mirrorOf(io)?.workers[0]?.activity).toBe('Bash: pnpm test')
  await steerRun(io, 'Use the brand colours')
  expect(mirrorOf(io)?.revision).toBe(2)
})

test('a mirror that cannot be written does not fail the board call', async () => {
  const io = ioWith(working())
  io.unwritable = [BOARD_FILE]
  const replied = await serveTool(io, call({ tool: 'mcp__meld__share', kind: 'fact', text: 'The tokens are in src/theme.css.', agentId: 'agent-1' }))
  expect(parsed(replied.result)).toMatchObject({ ok: true })
  expect(io.current?.context).toHaveLength(1)
})

test('deliver writes no mirror into the folder that it removed', async () => {
  const io = ioWith(runOf(declareFinal(runOf(takeIntegration(working(), 'w2', NOW)), 'w2', FULL, 'Done', NOW)))
  await deliver(io)
  expect(io.current?.state).toBe('delivered')
  expect(io.files[BOARD_FILE]).toBeUndefined()
})
