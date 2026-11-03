import { expect, test } from 'claude-code/testing'
import type { ToolCallInput } from 'claude-code'

import { deliver, discard, guardCall, markWorker, refreshFacts, serveTool, startRun, steerRun, stopOne } from '../hooks/actions'
import { addTasks, bindWorker, declareFinal, isFailure, startRun as startBoard, steer, takeIntegration } from '../hooks/board'
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
  expect(io.current?.workers.map(worker => worker.agentId)).toEqual(['agent-1', 'agent-2', 'agent-3'])
  expect(io.current?.state).toBe('working')
  expect(result.text).toBe(`Run ${ID}: 3 workers on git, from commit ${HEAD.slice(0, 7)}.`)
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

test('when all workers are idle and every task is done, the integrator is told to integrate', async () => {
  const io = ioWith(runOf(takeIntegration(working(), 'w2', NOW)))
  await markWorker(io, 'agent-1', 'idle')
  await markWorker(io, 'agent-2', 'idle')
  expect(io.sent).toHaveLength(1)
  expect(io.sent[0]).toContain('agent-2: meld: All tasks are done. Integrate')
})

test('when all workers are idle with open tasks, each live worker is woken with them', async () => {
  const io = ioWith(runOf(addTasks(working(3), 'w1', { seen: 0, tasks: [{ title: 'Tokens' }, { title: 'Docs' }] }, NOW)))
  await markWorker(io, 'agent-1', 'idle')
  await markWorker(io, 'agent-2', 'idle')
  await markWorker(io, 'agent-3', 'idle')
  expect(io.sent).toHaveLength(3)
  expect(io.sent[2]).toContain('#1 Tokens; #2 Docs')
})

test('after three nudges the person is told to steer, and a steer allows new nudges', async () => {
  const io = ioWith(working())
  await markWorker(io, 'agent-1', 'idle')
  await markWorker(io, 'agent-2', 'idle')
  await markWorker(io, 'agent-1', 'idle')
  await markWorker(io, 'agent-2', 'idle')
  await markWorker(io, 'agent-1', 'idle')
  expect(io.sent).toHaveLength(3)
  expect(io.toasts).toContain('meld: all workers are idle. Steer them or stop the run.')
  await steerRun(io, 'Add the docs')
  await markWorker(io, 'agent-2', 'idle')
  expect(io.sent).toHaveLength(6)
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
