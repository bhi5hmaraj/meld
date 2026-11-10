import { expect, test } from 'claude-code/testing'
import type { ToolCallInput } from 'claude-code'

import { compactWorker, deliver, discard, freshTokens, guardCall, markWorker, refreshFacts, restartIdleWorkers, serveTool, SPAWN_APPROVAL, spawnVerdict, startFromView, VCS_APPROVAL, vcsVerdict, startRun, steerRun, stopOne } from '../core/actions'
import { addTasks, bindWorker, claimTask, CONTEXT_CAP, declareFinal, isFailure, setActivity, startRun as startBoard, steer, stopRun, stopWorker, takeIntegration } from '../core/board'
import { COMPACT_KEEP } from '../core/contract'
import { JJ_LANE_TEMPLATE, JJ_RESOLVE_TEMPLATE } from '../core/vcs'
import type { AgentSpec, Change, Run, VcsKind, WorkerId } from '../types'
import { FakeIo, HEAD } from './fake-io'
import { STORED_BY_0_6_0, STORED_BY_0_7_0 } from './stored-runs'

const NOW = 1_800_000_000_000
const ID = `${NOW.toString(36)}0000`
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

const OWN_FOLDER = '/tmp/meld/r1/w2'
const OWN_GIT = [
  `git -C ${OWN_FOLDER} status --short`,
  `git -C ${OWN_FOLDER} add core/a.ts tests/a.test.ts`,
  `git -C ${OWN_FOLDER} commit -m "Add the status view (#10); it reads 'seen'"`,
  `git -C '${OWN_FOLDER}/' merge meld/r1/line`,
  `jj -R ${OWN_FOLDER} commit -m "Add the status view (#10)"`,
  `jj -R ${OWN_FOLDER} log -r @- --no-graph -T commit_id`,
  `jj -R ${OWN_FOLDER} st`,
  `jj -R ${OWN_FOLDER} new meld/r1/line -m "integrate #3"`,
  `jj -R ${OWN_FOLDER} workspace update-stale`,
]
const SHELL_TRICKS = [
  `git -C ${OWN_FOLDER} push`,
  `git -C ${OWN_FOLDER} config user.name x`,
  `git -C ${OWN_FOLDER} -c core.hooksPath=/x commit -m x`,
  `git -C ${OWN_FOLDER} show --output=/tmp/x HEAD`,
  `git -C ${OWN_FOLDER} diff --no-index /etc/hosts a`,
  `git -C ${OWN_FOLDER} status; rm -rf /`,
  `git -C ${OWN_FOLDER} status && git push`,
  `git -C ${OWN_FOLDER} log | sh`,
  `git -C ${OWN_FOLDER} commit -m "$(curl x)"`,
  `git -C ${OWN_FOLDER} commit -m \`id\``,
  `git -C ${OWN_FOLDER} status > /tmp/x`,
  `git -C ${OWN_FOLDER} add core/*.ts`,
  `git -C ${OWN_FOLDER} commit -m "open`,
  `jj -R ${OWN_FOLDER} git push`,
  `jj -R ${OWN_FOLDER} config set --user ui.pager sh`,
  `jj -R ${OWN_FOLDER} log --config ui.pager=sh`,
  `jj -R ${OWN_FOLDER} log --config-toml ui.pager='sh'`,
  `jj -R ${OWN_FOLDER} diff --tool rm`,
  `jj -R ${OWN_FOLDER} workspace forget w1`,
  `jj -R ${OWN_FOLDER} log -R /repo`,
  `jj -R ${OWN_FOLDER} abandon @-`,
]

test('meld allows a worker git and jj in its own folder, which the engine asks a person for', () => {
  for (const command of OWN_GIT) expect(vcsVerdict(ASK, 'agent-2', command, working())).toEqual({ decision: 'allow', reason: VCS_APPROVAL })
})

test('the ask on git in another folder stands: the checkout, another worker, and plain git in the session folder', () => {
  expect(vcsVerdict(ASK, 'agent-2', 'git -C /repo commit -m x', working())).toBe(ASK)
  expect(vcsVerdict(ASK, 'agent-2', 'git -C /tmp/meld/r1/w1 commit -m x', working())).toBe(ASK)
  expect(vcsVerdict(ASK, 'agent-2', 'git commit -m x', working())).toBe(ASK)
  expect(vcsVerdict(ASK, 'agent-2', 'jj -R /tmp/meld/r1/w1 commit -m x', working())).toBe(ASK)
  expect(vcsVerdict(ASK, 'agent-2', 'jj commit -m x', working())).toBe(ASK)
})

test('the ask on git of an agent that is no worker stands, and so does the main session', () => {
  expect(vcsVerdict(ASK, 'agent-9', `git -C ${OWN_FOLDER} commit -m x`, working())).toBe(ASK)
  expect(vcsVerdict(ASK, undefined, `git -C ${OWN_FOLDER} commit -m x`, working())).toBe(ASK)
})

test('the ask stands for other git commands, for options that write or read outside the folder, and for shell syntax', () => {
  for (const command of SHELL_TRICKS) expect(vcsVerdict(ASK, 'agent-2', command, working())).toBe(ASK)
})

test('a deny stands, and a stopped run allows no git', () => {
  const deny = { decision: 'deny' }
  expect(vcsVerdict(deny, 'agent-2', `git -C ${OWN_FOLDER} status`, working())).toBe(deny)
  expect(vcsVerdict(ASK, 'agent-2', `git -C ${OWN_FOLDER} status`, stopRun(working(), NOW))).toBe(ASK)
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
    'A run is active. Deliver, discard or stop it first: /meld-deliver, /meld-discard or /meld-stop, or the meld pane.',
  )
})

/** The jj log of the lane of a worker, read in its folder, so jj first records the files there. */
function jjFreshLog(run: string, worker: WorkerId): string {
  return `jj -R /tmp/meld/${run}/${worker} log --no-graph --limit 40 -r meld_base..${worker}@ -T ${JJ_LANE_TEMPLATE}`
}

/** The jj log of the commits since the base that no working copy holds. */
function jjStrayLog(run: string): string {
  return `jj -R /tmp/meld/${run}/jj --ignore-working-copy log --no-graph --limit 40 -r meld_base.. ~ ::working_copies() -T ${JJ_LANE_TEMPLATE}`
}

test('a start over a stopped run with no work removes its workspaces as Discard does, then starts', async () => {
  const io = ioWith(stopRun(working(), NOW))
  const result = await startRun(io, '/repo', { request: 'More', agents: TWO, vcs: 'git' })
  expect(io.commands).toContain('git worktree prune')
  expect(io.commands).toContain('git branch -D meld/r1/w2')
  expect(io.commands).toContain('git branch -D meld/r1/integration')
  expect(io.commands.indexOf('rm -rf -- /tmp/meld/r1')).toBeLessThan(io.commands.indexOf(`git worktree add -b meld/${ID}/w1 /tmp/meld/${ID}/w1 ${HEAD}`))
  expect(io.current?.id).toBe(ID)
  expect(result.text).toBe(`Run ${ID}: 2 workers on git, from commit ${HEAD.slice(0, 7)}.`)
})

test('a start after a start that started no worker removes the workspaces of the failed start', async () => {
  const io = ioWith(null)
  io.spawnDeny = 'the host limit'
  await startRun(io, '/repo', { request: 'Add a dark theme', agents: TWO, vcs: 'git' })
  io.spawnDeny = undefined
  io.now = async () => NOW + 60_000
  const result = await startRun(io, '/repo', { request: 'Add a dark theme', agents: TWO, vcs: 'git' })
  expect(io.commands).toContain(`git branch -D meld/${ID}/w2`)
  expect(io.commands).toContain(`rm -rf -- /tmp/meld/${ID}`)
  expect(io.current?.id).toBe(`${(NOW + 60_000).toString(36)}0000`)
  expect(result.text).toBe(`Run ${(NOW + 60_000).toString(36)}0000: 2 workers on git, from commit ${HEAD.slice(0, 7)}.`)
})

test('a start over a stopped run with commits refuses, and names the run, its folder and its count of commits', async () => {
  const io = ioWith(stopRun(working(), NOW))
  const other = 'e'.repeat(40)
  io.answers[`git log --format=%H%x09%P%x09%s -n 40 ${HEAD}..meld/r1/w1`] = `${FULL}\t${other} ${HEAD}\tMerge w2\n${other}\t${HEAD}\tAdd add()`
  io.answers[`git log --format=%H%x09%P%x09%s -n 40 ${HEAD}..meld/r1/w2`] = `${other}\t${HEAD}\tAdd add()`
  const result = await startRun(io, '/repo', { request: 'More', agents: TWO, vcs: 'git' })
  expect(result.text).toBe('Run r1 stopped with work in /tmp/meld/r1: 2 commits. /meld-discard or Discard in the meld pane removes its workspaces, then you can start again.')
  expect(io.ran('git worktree')).toBe(false)
  expect(io.ran('rm')).toBe(false)
  expect(io.spawned).toHaveLength(0)
  expect(io.current).toMatchObject({ id: 'r1', state: 'stopped' })
})

test('a start over a stopped run with uncommitted edits refuses, and names the workers that made them', async () => {
  const io = ioWith(stopRun(working(), NOW))
  io.dirty = true
  const result = await startRun(io, '/repo', { request: 'More', agents: TWO, vcs: 'git' })
  expect(result.text).toBe(
    'Run r1 stopped with work in /tmp/meld/r1: 0 commits, and uncommitted edits in w1 and w2. /meld-discard or Discard in the meld pane removes its workspaces, then you can start again.',
  )
  expect(io.ran('rm')).toBe(false)
})

test('a start over a stopped jj run reads each workspace in its folder, so edits that no jj command recorded count', async () => {
  const io = ioWith(stopRun(working(3, 'jj'), NOW))
  io.answers[jjFreshLog('r1', 'w2')] = `${FULL}\t1\t--\tw2@\t\n`
  const result = await startRun(io, '/repo', { request: 'More', agents: TWO, vcs: 'auto' })
  expect(result.text).toBe('Run r1 stopped with work in /tmp/meld/r1: 0 commits, and uncommitted edits in w2. /meld-discard or Discard in the meld pane removes its workspaces, then you can start again.')
  expect(io.commands.filter(command => command.includes(' log '))).toEqual([...(['w1', 'w2', 'w3'] as WorkerId[]).map(id => jjFreshLog('r1', id)), jjStrayLog('r1')])
  expect(io.ran('rm')).toBe(false)
})

test('a start over a stopped run whose workspaces meld cannot read refuses, and removes nothing', async () => {
  const io = ioWith(stopRun(working(), NOW))
  io.failing = [`git log --format=%H%x09%P%x09%s -n 40 ${HEAD}..meld/r1/w2`]
  const result = await startRun(io, '/repo', { request: 'More', agents: TWO, vcs: 'git' })
  expect(result.text).toBe(
    'Run r1 stopped, and meld cannot read its workspaces in /tmp/meld/r1 (w2: git: failed), so they can hold work. /meld-discard or Discard in the meld pane removes them, then you can start again.',
  )
  expect(io.ran('rm')).toBe(false)
  expect(io.current?.id).toBe('r1')
})

test('a start over a stopped run that meld 0.7.0 stored counts the commit of its done task as work', async () => {
  const io = ioWith(stopRun(STORED_BY_0_7_0, NOW))
  const toggle = STORED_BY_0_7_0.tasks[1]?.commit ?? ''
  io.answers[jjFreshLog('r070', 'w3')] = `${FULL}\t1\t-e\tw3@\t\n${toggle}\t1\t--\t\tDark toggle\n`
  const result = await startRun(io, '/repo', { request: 'More', agents: TWO, vcs: 'git' })
  expect(result.text).toBe('Run r070 stopped with work in /tmp/meld/r070: 1 commit. /meld-discard or Discard in the meld pane removes its workspaces, then you can start again.')
})

test('a start over a stopped run that meld 0.7.0 stored, with no work, removes its workspaces and starts', async () => {
  const io = ioWith(stopRun(STORED_BY_0_7_0, NOW))
  const result = await startRun(io, '/repo', { request: 'More', agents: TWO, vcs: 'git' })
  expect(io.commands).toContain('jj -R /tmp/meld/r070/jj config path --repo')
  expect(io.commands).toContain('rm -rf -- /tmp/meld/r070')
  expect(io.current?.id).toBe(ID)
  expect(result.text).toBe(`Run ${ID}: 2 workers on git, from commit ${HEAD.slice(0, 7)}.`)
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

test('a share answers with its entry; the first reply to an agent carries the context, and a later reply no entry of its own', async () => {
  const io = ioWith(working())
  const first = await serveTool(io, call({ tool: 'mcp__meld__share', kind: 'fact', text: 'The tokens are in src/theme.css.', files: ['src/theme.css'], agentId: 'agent-1' }))
  expect(parsed(first.result)).toMatchObject({
    ok: true,
    value: { kind: 'fact', by: 'w1' },
    context: [{ kind: 'fact', by: 'w1', text: 'The tokens are in src/theme.css.', files: ['src/theme.css'], seenBy: [] }],
  })
  const replied = await serveTool(io, call({ tool: 'mcp__meld__share', kind: 'fail', text: 'jj split opens an editor, and the call hangs.', agentId: 'agent-1' }))
  expect(parsed(replied.result)).toMatchObject({ ok: true, value: { kind: 'fail', by: 'w1', text: 'jj split opens an editor, and the call hangs.', files: [], seenBy: [] }, context: [] })
})

test('the board tools carry each entry to a worker once, in the first reply after the share', async () => {
  const io = ioWith(working())
  await serveTool(io, call({ tool: 'mcp__meld__share', kind: 'fact', text: 'The tokens are in src/theme.css.', agentId: 'agent-1' }))
  const read = parsed((await serveTool(io, call({ tool: 'mcp__meld__board', agentId: 'agent-2' }))).result)
  expect(read).toMatchObject({ context: [{ kind: 'fact', text: 'The tokens are in src/theme.css.', seenBy: ['w2'] }] })
  expect(parsed((await serveTool(io, call({ tool: 'mcp__meld__board', agentId: 'agent-2' }))).result)).toMatchObject({ context: [] })
  await serveTool(io, call({ tool: 'mcp__meld__share', kind: 'fail', text: 'jj split opens an editor, and the call hangs.', agentId: 'agent-1' }))
  const noted = parsed((await serveTool(io, call({ tool: 'mcp__meld__note', text: 'I take the toggle.', agentId: 'agent-2' }))).result) as { context: object[] }
  expect(noted.context).toEqual([expect.objectContaining({ kind: 'fail', seenBy: ['w2'] })])
})

test('the first board read of a restarted worker carries the current entries again', async () => {
  const io = ioWith(runOf(takeIntegration(working(), 'w2', NOW)))
  await serveTool(io, call({ tool: 'mcp__meld__share', kind: 'fact', text: 'The tokens are in src/theme.css.', agentId: 'agent-1' }))
  await serveTool(io, call({ tool: 'mcp__meld__board', agentId: 'agent-2' }))
  await markWorker(io, 'agent-1', 'idle')
  await markWorker(io, 'agent-2', 'idle')
  await restartIdleWorkers(io)
  const agent = io.current?.workers.find(worker => worker.id === 'w2')?.agentId
  expect(agent).toBe('spawned-1')
  const view = parsed((await serveTool(io, call({ tool: 'mcp__meld__board', agentId: agent }))).result)
  expect(view).toMatchObject({ context: [{ kind: 'fact', text: 'The tokens are in src/theme.css.', seenBy: ['w2'] }] })
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
  expect(io.toasts).toContain('meld: the result is ready. Deliver it with /meld-deliver or from the meld pane.')
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

test('a restart offers the tasks that a worker can claim, not a parent or a task that waits', async () => {
  const tasks = [{ title: 'Theme' }, { title: 'Tokens', parent: 1 }, { title: 'Docs', needs: [2] }]
  const io = ioWith(runOf(addTasks(working(3), 'w1', { seen: 0, tasks }, NOW)))
  await markWorker(io, 'agent-1', 'idle')
  await markWorker(io, 'agent-2', 'idle')
  await markWorker(io, 'agent-3', 'idle')
  await restartIdleWorkers(io)
  expect(io.spawned.map(spawn => spawn.description)).toEqual(['meld w1'])
  expect(io.spawned[0]?.prompt).toContain('These tasks are open: #2 Tokens. Claim one and do it.')
})

test('a worker that ended starts again when a working peer adds tasks, one for each task that the peer, which claims nothing yet, leaves', async () => {
  const io = ioWith(working(3))
  await markWorker(io, 'agent-2', 'idle')
  await markWorker(io, 'agent-3', 'idle')
  await serveTool(io, call({ tool: 'mcp__meld__add_tasks', seen: 0, tasks: [{ title: 'Tokens' }, { title: 'Docs' }], agentId: 'agent-1' }))
  await restartIdleWorkers(io)
  expect(io.spawned.map(spawn => spawn.description)).toEqual(['meld w2'])
  expect(io.spawned[0]?.prompt).toContain('These tasks are open: #1 Tokens; #2 Docs')
})

test('an owner that ended after it read the board stays idle until there is news', async () => {
  const io = ioWith(working(3))
  await serveTool(io, call({ tool: 'mcp__meld__add_tasks', seen: 0, tasks: [{ title: 'Tokens' }, { title: 'Docs' }], agentId: 'agent-1' }))
  await serveTool(io, call({ tool: 'mcp__meld__claim', task: 1, version: 1, agentId: 'agent-2' }))
  await serveTool(io, call({ tool: 'mcp__meld__board', agentId: 'agent-2' }))
  await markWorker(io, 'agent-2', 'idle')
  await restartIdleWorkers(io)
  expect(io.spawned).toHaveLength(0)
  await serveTool(io, call({ tool: 'mcp__meld__note', text: 'The tokens are in theme.css', agentId: 'agent-1' }))
  await restartIdleWorkers(io)
  expect(io.spawned.map(spawn => spawn.description)).toEqual(['meld w2'])
  expect(io.spawned[0]?.prompt).toContain('Your task is not done: #1 Tokens')
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
  expect(await steerRun(io, 'Use the brand colours')).toBe('Revision 2: 2 running workers get it; the other sees it when meld starts it again.')
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
  const merge = `git merge --no-ff -m meld: Done\n\nAdd a dark theme ${FULL}`
  expect(await deliver(io)).toBe(`Merged ${FULL.slice(0, 7)} into your branch.`)
  expect(io.commands).toContain(merge)
  expect(io.commands.indexOf('rm -rf -- /tmp/meld/r1')).toBeGreaterThan(io.commands.indexOf(merge))
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

test('add_tasks keeps the parent, the size and the needs of each new task', async () => {
  const io = ioWith(working())
  const tasks = [{ title: 'Theme', size: 'L' }, { title: 'Tokens', parent: 1, size: 's' }, { title: 'Docs', parent: '#1', needs: ['2'] }]
  await serveTool(io, call({ tool: 'mcp__meld__add_tasks', seen: 0, tasks, agentId: 'agent-1' }))
  expect(io.current?.tasks.map(task => [task.id, task.parent, task.size, task.needs])).toEqual([
    [1, undefined, 'L', undefined],
    [2, 1, 'S', undefined],
    [3, 1, undefined, [2]],
  ])
})

test('add_tasks reads one need that a model gives as a number', async () => {
  const io = ioWith(working())
  await serveTool(io, call({ tool: 'mcp__meld__add_tasks', seen: 0, tasks: [{ title: 'Tokens' }, { title: 'Docs', needs: 1 }], agentId: 'agent-1' }))
  expect(io.current?.tasks[1]?.needs).toEqual([1])
})

test('add_tasks refuses a size other than S, M or L', async () => {
  const io = ioWith(working())
  const replied = await serveTool(io, call({ tool: 'mcp__meld__add_tasks', seen: 0, tasks: [{ title: 'Tokens', size: 'XL' }], agentId: 'agent-1' }))
  expect(parsed(replied.result)).toMatchObject({ error: 'INVALID' })
  expect(io.current?.tasks).toEqual([])
})

test('a split through the board keeps the first part as the claim of the caller, and tells the working peers', async () => {
  const io = ioWith(claimedBy('w1'))
  const parts = [{ title: 'Light tokens' }, { title: 'Dark tokens', size: 'S' }]
  const replied = await serveTool(io, call({ tool: 'mcp__meld__split', task: 1, version: 2, seen: 1, tasks: parts, agentId: 'agent-1' }))
  expect(parsed(replied.result)).toMatchObject({ ok: true })
  expect(io.current?.tasks.map(task => [task.id, task.parent, task.state, task.owner, task.size])).toEqual([
    [1, undefined, 'open', undefined, undefined],
    [2, 1, 'claimed', 'w1', undefined],
    [3, 1, 'open', undefined, 'S'],
  ])
  expect(io.sent).toEqual(['agent-2: meld: There is open work on the board. Read the board with mcp__meld__board, then go on.'])
})

test('a split through the board with an old task list version fails with STALE_VERSION, gives the current tasks and changes nothing', async () => {
  const io = ioWith(runOf(addTasks(claimedBy('w1'), 'w2', { seen: 1, tasks: [{ title: 'Contrast check' }] }, NOW)))
  const parts = [{ title: 'Light tokens' }, { title: 'Dark tokens', needs: [2] }]
  const replied = await serveTool(io, call({ tool: 'mcp__meld__split', task: 1, version: 2, seen: 1, tasks: parts, agentId: 'agent-1' }))
  expect(parsed(replied.result)).toMatchObject({ error: 'STALE_VERSION', taskList: 2, tasks: [{ id: 1, title: 'Tokens' }, { id: 2, title: 'Contrast check' }] })
  expect(io.current?.tasks).toHaveLength(2)
  expect(io.current?.taskList).toBe(2)
})

test('a split through the board with no task list version is stale', async () => {
  const io = ioWith(claimedBy('w1'))
  const replied = await serveTool(io, call({ tool: 'mcp__meld__split', task: 1, version: 2, tasks: [{ title: 'Light tokens' }, { title: 'Dark tokens' }], agentId: 'agent-1' }))
  expect(parsed(replied.result)).toMatchObject({ error: 'STALE_VERSION', taskList: 1 })
  expect(io.current?.tasks).toHaveLength(1)
})

test('a split ends the count of the leaf, and its first part counts from zero', async () => {
  const io = ioWith(claimedBy('w2'))
  for (let calls = 2; calls < 60; calls++) await guardCall(io, call({ tool: 'Bash', command: 'ls', agentId: 'agent-2' }))
  const parts = [{ title: 'Light tokens' }, { title: 'Dark tokens' }]
  await serveTool(io, call({ tool: 'mcp__meld__split', task: 1, version: 2, seen: 1, tasks: parts, agentId: 'agent-2' }))
  for (let calls = 0; calls < 5; calls++) await guardCall(io, call({ tool: 'Bash', command: 'ls', agentId: 'agent-2' }))
  expect(io.sent.filter(message => message.includes('Split #'))).toEqual([])
  expect(io.current?.tasks[1]).toMatchObject({ owner: 'w2', calls: 6 })
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
  expect(parsed(replied.result)).toEqual({ text: 'Stopped. The workspaces stay until you discard them with /meld-discard or in the meld pane.' })
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

function claimedBy(id: WorkerId): Run {
  return runOf(claimTask(runOf(addTasks(working(), 'w1', { seen: 0, tasks: [{ title: 'Tokens' }] }, NOW)), id, 1, 1, NOW))
}

test('a worker with 60 tool calls on one leaf with no size is told one time to split it or finish it', async () => {
  const io = ioWith(claimedBy('w2'))
  for (let calls = 0; calls <= 60; calls++) await guardCall(io, call({ tool: 'Bash', command: 'pnpm test', agentId: 'agent-2' }))
  expect(io.sent).toEqual(['agent-2: Split #1 into smaller tasks, or finish it.'])
  expect(io.current?.tasks[0]).toMatchObject({ calls: 61, nudged: true })
})

test('the owner of an S leaf is told to split it after 30 tool calls, and of an L leaf after 120', async () => {
  const sized = runOf(addTasks(working(), 'w1', { seen: 0, tasks: [{ title: 'Tokens', size: 'S' }, { title: 'Toggle', size: 'L' }] }, NOW))
  const io = ioWith(runOf(claimTask(runOf(claimTask(sized, 'w1', 1, 1, NOW)), 'w2', 2, 1, NOW)))
  for (let calls = 1; calls < 30; calls++) await guardCall(io, call({ tool: 'Bash', command: 'ls', agentId: 'agent-1' }))
  expect(io.sent).toEqual([])
  await guardCall(io, call({ tool: 'Bash', command: 'ls', agentId: 'agent-1' }))
  expect(io.sent).toEqual(['agent-1: Split #1 into smaller tasks, or finish it.'])
  for (let calls = 1; calls < 120; calls++) await guardCall(io, call({ tool: 'Bash', command: 'ls', agentId: 'agent-2' }))
  expect(io.sent).toHaveLength(1)
  await guardCall(io, call({ tool: 'Bash', command: 'ls', agentId: 'agent-2' }))
  expect(io.sent).toEqual(['agent-1: Split #1 into smaller tasks, or finish it.', 'agent-2: Split #2 into smaller tasks, or finish it.'])
})

test('a board read counts toward the nudge of a leaf', async () => {
  const io = ioWith(claimedBy('w2'))
  for (let calls = 1; calls < 60; calls++) await guardCall(io, call({ tool: 'Read', file_path: '/tmp/meld/r1/w2/a.ts', agentId: 'agent-2' }))
  expect(io.sent).toEqual([])
  await serveTool(io, call({ tool: 'mcp__meld__board', agentId: 'agent-2' }))
  expect(io.sent).toEqual(['agent-2: Split #1 into smaller tasks, or finish it.'])
})

test('a board tool call counts toward the nudge of a leaf', async () => {
  const io = ioWith(claimedBy('w1'))
  for (let calls = 1; calls < 60; calls++) await guardCall(io, call({ tool: 'Bash', command: 'ls', agentId: 'agent-1' }))
  await serveTool(io, call({ tool: 'mcp__meld__note', text: 'The tokens are in theme.css', agentId: 'agent-1' }))
  expect(io.sent).toContain('agent-1: Split #1 into smaller tasks, or finish it.')
})

test('the owner of a leaf with no size in a run that meld 0.6.0 stored is told to split it after 60 tool calls', async () => {
  const io = ioWith(STORED_BY_0_6_0)
  for (let calls = 1; calls < 60; calls++) await guardCall(io, call({ tool: 'Bash', command: 'ls', agentId: 'agent-1' }))
  expect(io.sent).toEqual([])
  await guardCall(io, call({ tool: 'Bash', command: 'ls', agentId: 'agent-1' }))
  expect(io.sent).toEqual(['agent-1: Split #2 into smaller tasks, or finish it.'])
})

test('a restart of a run that meld 0.6.0 stored offers its open task and the task of its owner', async () => {
  const io = ioWith(STORED_BY_0_6_0)
  await markWorker(io, 'agent-1', 'idle')
  await restartIdleWorkers(io)
  expect(io.spawned.map(spawn => spawn.description)).toEqual(['meld w1', 'meld w2'])
  expect(io.spawned[0]?.prompt).toContain('Your task is not done: #2 Dark toggle')
  expect(io.spawned[1]?.prompt).toContain('These tasks are open: #3 Docs')
})

test('a worker that finishes its leaf before 60 tool calls is not told to split it', async () => {
  const io = ioWith(claimedBy('w2'))
  io.answers['git rev-parse --verify --quiet HEAD^{commit}'] = FULL
  for (let calls = 2; calls < 60; calls++) await guardCall(io, call({ tool: 'Bash', command: 'ls', agentId: 'agent-2' }))
  await serveTool(io, call({ tool: 'mcp__meld__finish_task', task: 1, version: 2, commit: 'HEAD', summary: 'Tokens', agentId: 'agent-2' }))
  for (let calls = 0; calls < 5; calls++) await guardCall(io, call({ tool: 'Bash', command: 'ls', agentId: 'agent-2' }))
  expect(io.sent).toEqual([])
})

test('a start while another start makes its workspaces, as a second click on Start does, makes and starts nothing', async () => {
  const io = ioWith(null)
  let release = () => {}
  io.gates[`git worktree add -b meld/${ID}/w1 /tmp/meld/${ID}/w1 ${HEAD}`] = new Promise<void>(resolve => (release = resolve))
  const first = startRun(io, '/repo', { request: 'Add a dark theme', agents: TWO, vcs: 'git' })
  while (!io.ran('git worktree add')) await io.sleep()
  const second = startRun(io, '/repo', { request: 'Add a dark theme', agents: TWO, vcs: 'git' })
  release()
  expect((await second).text).toBe('A run is active. Deliver, discard or stop it first: /meld-deliver, /meld-discard or /meld-stop, or the meld pane.')
  expect((await first).text).toBe(`Run ${ID}: 2 workers on git, from commit ${HEAD.slice(0, 7)}.`)
  expect(io.commands.filter(command => command.startsWith('git worktree add'))).toHaveLength(2)
  expect(io.spawned).toHaveLength(2)
})

test('the claim of a stopped worker through the board tool fails, and the task stays open for another worker', async () => {
  const io = ioWith(stopWorker(runOf(addTasks(working(), 'w1', { seen: 0, tasks: [{ title: 'Tokens' }] }, NOW)), 'w2', NOW))
  const replied = await serveTool(io, call({ tool: 'mcp__meld__claim', task: 1, version: 1, agentId: 'agent-2' }))
  expect(JSON.parse(String(replied.result))).toMatchObject({ error: 'WORKER_STOPPED' })
  expect(io.current?.tasks[0]).toMatchObject({ state: 'open', version: 1 })
})

test('a worker whose context passes the cap gets no nudge before its call limit: its agent compacts', async () => {
  const claimed = claimedBy('w2')
  const full = { used: CONTEXT_CAP, size: 1_000_000 }
  const io = ioWith({ ...claimed, workers: claimed.workers.map(worker => (worker.id === 'w2' ? { ...worker, context: full } : worker)) })
  await guardCall(io, call({ tool: 'Bash', command: 'ls', agentId: 'agent-2' }))
  expect(io.sent).toEqual([])
})

test('after its agent compacts, the next board read of a worker gives its rules again, and the summary keeps its task', async () => {
  const io = ioWith(working())
  await serveTool(io, call({ tool: 'mcp__meld__board', agentId: 'agent-2' }))
  const keep = await compactWorker(io, 'agent-2')
  const read = parsed((await serveTool(io, call({ tool: 'mcp__meld__board', agentId: 'agent-2' }))).result) as { rules?: string }
  expect(keep).toBe(COMPACT_KEEP)
  expect(read.rules).toContain('You are w2')
})

test('the compaction of an agent that is no worker changes nothing', async () => {
  const io = ioWith(working())
  expect(await compactWorker(io, 'agent-9')).toBeUndefined()
})
