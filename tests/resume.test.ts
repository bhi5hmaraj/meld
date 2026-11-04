import { expect, test } from 'claude-code/testing'

import { bindWorker, isFailure, setActivity, startRun, stopRun } from '../core/board'
import type { Adopted, Boards, BoardSummary } from '../core/remote-store'
import { resumeRun } from '../core/resume'
import type { Change, Run, WorkerId } from '../types'
import { FakeIo, HEAD } from './fake-io'

const NOW = 1_800_000_000_000
const MINUTE = 60_000
const IDS: WorkerId[] = ['w1', 'w2']

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

/** A run of another session: two workers whose agents ended with that session, quiet for ten minutes. */
function oldRun(): Run {
  const workers = IDS.map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: `meld/r1/${id}`, agent: { type: 'meld:worker' } }))
  let run = startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW - 10 * MINUTE, workers })
  for (const [index, id] of IDS.entries()) run = setActivity(runOf(bindWorker(run, id, `old-agent-${index + 1}`, NOW - 10 * MINUTE)), id, 'Edit theme.css', NOW - 10 * MINUTE)
  return run
}

function summary(board: string, run: Run, ownerAt: number): BoardSummary {
  return { board, run: run.id, state: run.state, request: run.request, repo: run.repo, owner: `session-${board}`, ownerAt }
}

/** The boards of the machine: a use of a board gives the fake Io the run that the board holds. */
class FakeBoards implements Boards {
  board = 'mine'
  summaries: BoardSummary[] = []
  adopted: Adopted = 'adopted'
  used: string[] = []

  constructor(
    private readonly io: FakeIo,
    private readonly runs: Record<string, Run>,
  ) {}

  current(): string {
    return this.board
  }

  async list(): Promise<BoardSummary[]> {
    return this.summaries
  }

  async adopt(): Promise<Adopted> {
    return this.adopted
  }

  async use(board: string): Promise<void> {
    this.used.push(board)
    this.board = board
    this.io.current = this.runs[board] ?? null
  }
}

function session(runs: Record<string, Run> = { old: oldRun() }): { io: FakeIo; boards: FakeBoards } {
  const io = new FakeIo()
  io.now = async () => NOW
  io.agentStates = new Map()
  io.usd = 2.5
  return { io, boards: new FakeBoards(io, runs) }
}

test('without meld mcp, /meld-resume says that it needs Bun and why meld mcp did not connect, and changes nothing', async () => {
  const { io } = session()
  const text = await resumeRun(io, 'bun: not found', '')
  expect(text).toContain('needs Bun')
  expect(text).toContain('meld mcp did not connect: bun: not found')
  expect(io.current).toBeNull()
})

test('the list names each live or stopped run of another session with its board, not the run of this session', async () => {
  const { io, boards } = session()
  const run = oldRun()
  boards.summaries = [summary('mine', run, NOW), summary('old', run, NOW - 5 * MINUTE), summary('done', { ...run, state: 'delivered' }, NOW)]
  const text = await resumeRun(io, boards, '')
  expect(text).toBe('Runs of other sessions:\n- old: run r1, working, "Add a dark theme" in /repo, last write 5 min ago\n/meld-resume <board> resumes one, 60 s after its last write.')
})

test('with no run of another session, the list says so', async () => {
  const { io, boards } = session()
  expect(await resumeRun(io, boards, '')).toBe('No run of another session is on this machine.')
})

test('a resume of a board whose owner wrote within its lease is refused', async () => {
  const { io, boards } = session()
  boards.adopted = { owner: 'session-old', ownerAt: NOW - 10_000 }
  expect(await resumeRun(io, boards, 'old')).toBe('Another session wrote that run 10 s ago, so it can still work on it. A session resumes a run 60 s after its last write.')
  expect(boards.used).toEqual([])
})

test('a resume while this session has a live run is refused, so the agents of that run write to no other board', async () => {
  const { io, boards } = session()
  io.current = oldRun()
  expect(await resumeRun(io, boards, 'old')).toBe('This session has a live run. Deliver, discard or stop it first: /meld-deliver, /meld-discard or /meld-stop.')
  expect(boards.used).toEqual([])
})

test('a resume takes the board, counts the cost from now, and starts the quiet workers again', async () => {
  const { io, boards } = session()
  const text = await resumeRun(io, boards, 'old')
  expect(boards.used).toEqual(['old'])
  expect(io.current?.costAtStart).toBe(2.5)
  expect(io.current?.log.some(entry => entry.text === 'resumed in a new session')).toBe(true)
  expect(io.spawned.map(spawn => spawn.description)).toEqual(['meld w1'])
  expect(text).toBe('Resumed run r1, "Add a dark theme": meld starts w1 again.')
})

test('a resume of a run whose workspaces are gone says so, and starts no worker', async () => {
  const { io, boards } = session()
  io.failing = ['test -d /tmp/meld/r1']
  expect(await resumeRun(io, boards, 'old')).toBe('Resumed run r1, but its workspaces in /tmp/meld/r1 are gone. /meld-discard removes the run.')
  expect(io.spawned).toEqual([])
})

test('a resume of a stopped run takes the board and starts no worker', async () => {
  const { io, boards } = session({ old: stopRun(oldRun(), NOW - 5 * MINUTE) })
  expect(await resumeRun(io, boards, 'old')).toBe('Resumed run r1, which is stopped. /meld-discard removes its workspaces.')
  expect(io.spawned).toEqual([])
})

test('a resume of a board with no run, and of the board of this session, change nothing', async () => {
  const { io, boards } = session()
  boards.adopted = 'missing'
  expect(await resumeRun(io, boards, 'nothing')).toBe('There is no run on the board nothing.')
  expect(await resumeRun(io, boards, 'mine')).toBe('This session works on that board already.')
  expect(boards.used).toEqual([])
})
