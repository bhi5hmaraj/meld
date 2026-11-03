import { expect, test } from 'claude-code/testing'
import type { ToolCallInput } from 'claude-code'

import { bindAgent, claimSlot, deliver, guardCall, markWorker, serveTool, startRun, steerRun, stopOne } from '../hooks/actions'
import { addTasks, bindWorker, declareFinal, isFailure, startRun as startBoard, steer, takeIntegration, workerOf } from '../hooks/board'
import type { Io, ProcessResult } from '../hooks/io'
import type { Change, Run } from '../types'

const NOW = 1_800_000_000_000
const ID = NOW.toString(36)
const HEAD = 'abc1234def5678'
const WORKERS = [
  { path: '/tmp/meld/r1/w1', branch: 'meld/r1/w1' },
  { path: '/tmp/meld/r1/w2', branch: 'meld/r1/w2' },
]

class FakeIo implements Io {
  current: Run | null = null
  repos = ['/repo', '/elsewhere']
  dirty = false
  commits: string[] = []
  commands: string[] = []
  sent: string[] = []
  toasts: string[] = []
  submitted: string[] = []

  async run(argv: string[], cwd: string): Promise<ProcessResult> {
    const command = argv.join(' ')
    this.commands.push(command)
    if (command === 'git rev-parse --show-toplevel') return this.rootOf(cwd)
    if (command === 'git rev-parse HEAD') return answer(HEAD)
    if (command === 'git status --porcelain') return answer(this.dirty ? ' M src/a.ts' : '')
    if (command.startsWith('git cat-file -e')) return this.commits.some(commit => command.includes(commit)) ? answer('') : refusal('missing')
    return answer('')
  }

  rootOf(cwd: string): ProcessResult {
    const root = this.repos.find(repo => cwd === repo || cwd.startsWith(`${repo}/`))
    return root ? answer(root) : refusal('not a git repository')
  }

  async now(): Promise<number> {
    return NOW
  }

  async sleep(): Promise<void> {}

  async read(): Promise<Run | null> {
    return this.current
  }

  async write(change: (run: Run | null) => Run | null): Promise<unknown> {
    this.current = change(this.current)
    return this.current
  }

  async send(agentId: string, text: string): Promise<unknown> {
    this.sent.push(`${agentId}: ${text}`)
    return undefined
  }

  toast(text: string): unknown {
    this.toasts.push(text)
    return undefined
  }

  async openPane(): Promise<unknown> {
    return undefined
  }

  async submit(text: string): Promise<unknown> {
    this.submitted.push(text)
    return undefined
  }
}

function answer(stdout: string): ProcessResult {
  return { exitCode: 0, stdout, stderr: '' }
}

function refusal(stderr: string): ProcessResult {
  return { exitCode: 128, stdout: '', stderr }
}

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

function working(): Run {
  const fresh = startBoard({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, now: NOW, workers: WORKERS })
  return runOf(bindWorker(runOf(bindWorker(fresh, 'w1', 'agent-1', NOW)), 'w2', 'agent-2', NOW))
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

test('a run makes two worktrees from HEAD and asks Claude for two forks', async () => {
  const io = ioWith(null)
  const result = await startRun(io, '/repo/apps', 'Add a dark theme')
  expect(io.commands).toContain(`git worktree add -b meld/${ID}/w1 /tmp/meld/${ID}/w1 ${HEAD}`)
  expect(io.commands).toContain(`git worktree add -b meld/${ID}/w2 /tmp/meld/${ID}/w2 ${HEAD}`)
  expect(io.current?.state).toBe('starting')
  expect(io.submitted[0]).toContain('subagent_type "fork"')
  expect(result.context?.[0]).toContain('Add a dark theme')
})

test('a run starts in another repository when the task begins with its path', async () => {
  const io = ioWith(null)
  await startRun(io, '/repo', '/elsewhere Add a dark theme')
  expect(io.commands).toContain(`git worktree add -b meld/${ID}/w1 /tmp/meld/${ID}/w1 ${HEAD}`)
  expect(io.current?.request).toBe('Add a dark theme')
  expect(io.current?.repo).toBe('/elsewhere')
})

test('a task that begins with a slash but names no repository stays whole', async () => {
  const io = ioWith(null)
  await startRun(io, '/repo', '/api routes need tests')
  expect(io.current?.request).toBe('/api routes need tests')
  expect(io.current?.repo).toBe('/repo')
})

test('a run does not start outside a git repository', async () => {
  const io = ioWith(null)
  io.repos = []
  expect((await startRun(io, '/tmp', 'Add a dark theme')).text).toBe('meld needs a git repository in the working directory.')
  expect(io.current).toBeNull()
})

test('the first two forks of the main loop become w1 and w2, and no other spawn is taken', async () => {
  const io = ioWith(null)
  await startRun(io, '/repo', 'Add a dark theme')
  expect(await claimSlot(io, true, 'a-subagent')).toBeUndefined()
  expect(await claimSlot(io, false, undefined)).toBeUndefined()
  expect((await claimSlot(io, true, undefined))?.id).toBe('w1')
  expect((await claimSlot(io, true, undefined))?.id).toBe('w2')
  expect(await claimSlot(io, true, undefined)).toBeUndefined()
})

test('a fork binds to its worker when its spawn returns', async () => {
  const io = ioWith(null)
  await startRun(io, '/repo', 'Add a dark theme')
  await claimSlot(io, true, undefined)
  await bindAgent(io, 'w1', 'agent-1')
  expect(workerOf(io.current as Run, 'agent-1')?.id).toBe('w1')
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
  const replied = await serveTool(io, call({ tool: 'mcp__meld__finish', commit: 'fff0000', summary: 'Done', agentId: 'agent-2' }))
  expect(parsed(replied.result)).toMatchObject({ error: 'NOT_FOUND' })
  expect(io.current?.state).toBe('working')
})

test('a final commit tells the other worker to stop and the person that the result is ready', async () => {
  const io = ioWith(runOf(takeIntegration(working(), 'w2', NOW)))
  io.commits = ['fff0000']
  await serveTool(io, call({ tool: 'mcp__meld__finish', commit: 'fff0000', summary: 'Done', agentId: 'agent-2' }))
  expect(io.current?.state).toBe('ready')
  expect(io.sent).toContain('agent-1: meld: the final commit is declared. End your turn now.')
  expect(io.toasts).toContain('meld: the result is ready. Deliver it from the meld pane.')
})

test('a steer reaches both live workers', async () => {
  const io = ioWith(working())
  expect(await steerRun(io, 'Use the brand colours')).toBe('meld: both workers get revision 2.')
  expect(io.sent).toHaveLength(2)
})

test('when both workers are idle and all tasks are done, the integrator is told to integrate', async () => {
  const io = ioWith(runOf(takeIntegration(working(), 'w2', NOW)))
  await markWorker(io, 'agent-1', 'idle')
  await markWorker(io, 'agent-2', 'idle')
  expect(io.sent).toHaveLength(1)
  expect(io.sent[0]).toContain('agent-2: meld: All tasks are done. Integrate')
})

test('after three nudges the person is told to steer, and a steer allows new nudges', async () => {
  const io = ioWith(working())
  await markWorker(io, 'agent-1', 'idle')
  await markWorker(io, 'agent-2', 'idle')
  await markWorker(io, 'agent-1', 'idle')
  await markWorker(io, 'agent-2', 'idle')
  await markWorker(io, 'agent-1', 'idle')
  expect(io.sent).toHaveLength(3)
  expect(io.toasts).toContain('meld: both workers are idle. Steer them or stop the run.')
  await steerRun(io, 'Add the docs')
  await markWorker(io, 'agent-2', 'idle')
  expect(io.sent).toHaveLength(6)
})

test('deliver refuses a checkout with uncommitted changes', async () => {
  const io = ioWith(runOf(declareFinal(runOf(takeIntegration(working(), 'w2', NOW)), 'w2', 'fff0000', 'Done', NOW)))
  io.dirty = true
  expect(await deliver(io)).toBe('meld: commit or stash the changes in your checkout first, then deliver.')
  expect(io.commands.some(command => command.startsWith('git merge'))).toBe(false)
})

test('deliver merges the final commit, then removes the worktrees and branches', async () => {
  const io = ioWith(runOf(declareFinal(runOf(takeIntegration(working(), 'w2', NOW)), 'w2', 'fff0000', 'Done', NOW)))
  expect(await deliver(io)).toBe('meld: merged fff0000 into your branch.')
  expect(io.commands).toContain('git merge --no-ff -m meld: Add a dark theme fff0000')
  expect(io.commands).toContain('git worktree remove --force /tmp/meld/r1/w2')
  expect(io.commands).toContain('git branch -D meld/r1/w1')
  expect(io.current?.state).toBe('delivered')
})

test('a board read from the main session is a string the model can read', async () => {
  const io = ioWith(null)
  const replied = await serveTool(io, call({ tool: 'mcp__meld__board' }))
  expect(typeof replied.result).toBe('string')
  expect(parsed(replied.result)).toMatchObject({ state: 'none' })
})

test('a stale add from a worker answers with the tasks of the other worker', async () => {
  const io = ioWith(working())
  await serveTool(io, call({ tool: 'mcp__meld__add_tasks', seen: 0, tasks: [{ title: 'src/math.js: add and multiply' }], agentId: 'agent-1' }))
  const replied = await serveTool(io, call({ tool: 'mcp__meld__add_tasks', seen: 0, tasks: [{ title: 'src/math.js: export add and multiply' }], agentId: 'agent-2' }))
  expect(parsed(replied.result)).toMatchObject({ error: 'STALE_TASK_LIST', taskList: 1, tasks: [{ id: 1, title: 'src/math.js: add and multiply' }] })
  expect(io.current?.tasks).toHaveLength(1)
})
