import { expect, test } from 'claude-code/testing'

import { startRun } from '../core/board'
import { remoteStore } from '../core/remote-store'
import type { BoardRead, BoardServer, Committed } from '../core/remote-store'
import type { Facts, Run } from '../types'
import { HEAD } from './fake-io'
import { STORE_CHECKS } from './store-conformance'

const NOW = 1_800_000_000_000

/** A board server in memory that compares versions, and lets other calls run between a read and a commit, as a process does. */
class VersionedBoard implements BoardServer {
  run: Run | null = null
  facts: Facts | null = null
  version = 0
  answer: Committed | undefined = undefined

  async read(): Promise<BoardRead> {
    await Promise.resolve()
    return { run: this.run, facts: this.facts, version: this.version }
  }

  async commit(run: Run | null, version: number): Promise<Committed> {
    await Promise.resolve()
    if (this.answer) return this.answer
    if (version !== this.version) return 'stale'
    this.run = run
    this.version += 1
    return 'committed'
  }

  async writeFacts(facts: Facts | null): Promise<void> {
    this.facts = facts
  }
}

function newRun(): Run {
  const workers = [{ id: 'w1' as const, path: '/tmp/meld/r1/w1', ref: 'meld/r1/w1', agent: { type: 'meld:worker' } }]
  return startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers })
}

for (const [name, check] of STORE_CHECKS) test(`the store over a board server: ${name}`, () => check(remoteStore(new VersionedBoard())))

test('a commit that another session refuses rejects the write with the reason, and changes nothing', async () => {
  const server = new VersionedBoard()
  server.answer = 'taken'
  const store = remoteStore(server)
  expect(await store.write(newRun).then(() => 'stored', (error: unknown) => String(error))).toContain('another session works on this run')
  expect(server.run).toBeNull()
})

test('a write that loses each race gives up after its tries, and says so', async () => {
  const server = new VersionedBoard()
  server.answer = 'stale'
  expect(await remoteStore(server).write(newRun).then(() => 'stored', (error: unknown) => String(error))).toContain('another write came first')
})

test('the cache of the pane gets each stored run, and the facts', async () => {
  const cached: unknown[] = []
  const store = remoteStore(new VersionedBoard(), { run: async run => cached.push(run?.id ?? null), facts: async facts => cached.push(facts?.run ?? null) })
  await store.write(newRun)
  await store.writeFacts({ run: 'r1', lanes: [] })
  await store.write(() => null)
  expect(cached).toEqual(['r1', 'r1', null])
})

test('a read of a run that another process changed refreshes the cache once', async () => {
  const server = new VersionedBoard()
  const cached: unknown[] = []
  const store = remoteStore(server, { run: async run => cached.push(run?.revision ?? null), facts: async () => undefined })
  await store.read()
  server.run = { ...newRun(), revision: 5 }
  server.version = 3
  await store.read()
  await store.read()
  expect(cached).toEqual([null, 5])
})
