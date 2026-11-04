import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { deliver, readRun, serveTool, startRun } from '../core/actions'
import { TOOL } from '../core/contract'
import { parseStart } from '../core/options'
import type { AgentState, Io, Runner, SpawnArgs, Spawned } from '../core/ports'
import { runHome } from '../core/vcs'
import { sessionRunner } from '../hooks/board-store'
import type { Run, Task } from '../types'
import { bunCodeHost } from './code-host'
import { mcpIo } from './io'
import { AcpRunner } from './leader'
import { SqliteBoards } from './sqlite-store'

const BOARD = 'run-session'
const CLAUDE_AGENT = 'agent-1'
const SESSION = { server: 'plugin:meld:board', id: BOARD, owner: BOARD, problem: '', channel: '' }
const STUB_WORKER = { codex: ['bun', join(import.meta.dir, 'stub-worker.spec-helper.ts')] }
const START = '--agents meld:worker,codex --vcs git Add a greeting and a farewell'
const RUN_MS = 30_000
const cleanups: string[] = []
const runners: AcpRunner[] = []

type View = { taskList: number; tasks: Task[] }

/** The engine of the session: it starts each Claude worker as agent-1, keeps it live, and records the messages to it. */
class Engine implements Runner {
  readonly sent: string[] = []

  async spawn(_args: SpawnArgs): Promise<Spawned> {
    return { agentId: CLAUDE_AGENT }
  }

  async send(agentId: string, text: string): Promise<void> {
    this.sent.push(`${agentId}: ${text}`)
  }

  async agents(): Promise<Map<string, AgentState>> {
    return new Map([[CLAUDE_AGENT, 'live']])
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await bunCodeHost.run(['git', ...args], cwd)
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

async function repository(folder: string): Promise<string> {
  const repo = join(folder, 'repo')
  await git(folder, 'init', '-q', '-b', 'main', repo)
  await git(repo, 'config', 'user.email', 'meld@example.com')
  await git(repo, 'config', 'user.name', 'meld')
  await Bun.write(join(repo, 'README.md'), 'base\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-q', '-m', 'base')
  return repo
}

/** A board call of the Claude worker, as the board hook of the plugin serves it. */
async function claude<T>(io: Io, tool: string, args: Record<string, unknown> = {}): Promise<T> {
  return JSON.parse((await serveTool(io, { tool, agentId: CLAUDE_AGENT, ...args })).result) as T
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let wait = 0; wait < 800 && !(await check()); wait++) await Bun.sleep(25)
  if (!(await check())) throw new Error('it did not happen')
}

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stopAll()
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true })
})

test(
  'a run with a Claude worker and a Codex worker goes from start to delivery: each does a task, Codex the one that waits for the other, then integrates, and the main session delivers',
  async () => {
    const folder = mkdtempSync(join(tmpdir(), 'meld-run-'))
    cleanups.push(folder)
    const repo = await repository(folder)
    const boards = new SqliteBoards(join(folder, 'meld.db'))
    const runner = new AcpRunner(boards, { commands: STUB_WORKER, pollMs: 20 })
    runner.lead(BOARD, BOARD)
    runners.push(runner)
    const engine = new Engine()
    const io: Io = { ...mcpIo(boards, BOARD), ...sessionRunner(SESSION, engine, runner.runnerFor(BOARD)) }
    const options = parseStart(START)
    if ('error' in options) throw new Error(options.error)
    expect((await startRun(io, repo, options)).text).toContain('2 workers on git')
    const started = (await readRun(io)) as Run
    cleanups.push(runHome(started.id))
    const [w1, w2] = started.workers
    expect(w1?.agentId).toBe(CLAUDE_AGENT)
    expect(w2?.agentId).toStartWith('acp-')

    const planned = await claude<View>(io, TOOL.board)
    const tasks = [{ title: 'Add a greeting' }, { title: 'Add a farewell', detail: 'bye.txt', needs: [1] }]
    await claude(io, TOOL.addTasks, { seen: planned.taskList, tasks })
    const greeting = (await claude<View>(io, TOOL.board)).tasks[0] as Task
    await claude(io, TOOL.claim, { task: greeting.id, version: greeting.version })
    await Bun.write(join(w1?.path ?? '', 'hello.txt'), 'hello\n')
    await git(w1?.path ?? '', 'add', 'hello.txt')
    await git(w1?.path ?? '', 'commit', '-q', '-m', 'Add a greeting')
    const claimed = (await claude<View>(io, TOOL.board)).tasks[0] as Task
    await claude(io, TOOL.finishTask, { task: claimed.id, version: claimed.version, commit: 'HEAD', summary: 'Added hello.txt' })

    await until(async () => (await readRun(io))?.state === 'ready')
    const ready = (await readRun(io)) as Run
    expect(ready.final?.by).toBe('w2')
    expect(ready.workers[1]?.activity).toContain('bye.txt')
    const forPlugin = boards.takeActions(BOARD, 'engine').map(action => `${action.kind} ${action.agent}: ${action.text}`)
    expect(forPlugin).toContain(`send ${CLAUDE_AGENT}: The final commit is declared. End your turn now.`)
    expect(forPlugin).toContain('toast : meld: the result is ready. Deliver it with /meld-deliver or from the meld pane.')

    expect(await deliver(io)).toStartWith('Merged ')
    expect(await git(repo, 'show', 'HEAD:hello.txt')).toBe('hello')
    expect(await git(repo, 'show', 'HEAD:bye.txt')).toBe('Add a farewell')
    expect((await readRun(io))?.state).toBe('delivered')
  },
  RUN_MS,
)
