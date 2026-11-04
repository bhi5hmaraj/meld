import { expect } from 'claude-code/testing'

import { startRun } from '../core/board'
import type { Store } from '../core/ports'
import type { Facts, Run } from '../types'
import { HEAD } from './fake-io'

const NOW = 1_800_000_000_000
const FACTS: Facts = { run: 'r1', lanes: [{ id: 'w1', commits: [], edits: true }] }

function newRun(): Run {
  const workers = [{ id: 'w1' as const, path: '/tmp/meld/r1/w1', ref: 'meld/r1/w1', agent: { type: 'meld:worker' } }]
  return startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers })
}

function nextRevision(run: Run | null): Run | null {
  return run && { ...run, revision: run.revision + 1 }
}

function failingChange(): Run | null {
  throw new Error('the change failed')
}

async function emptyStore(store: Store): Promise<void> {
  expect(await store.read()).toBeNull()
  expect(await store.readFacts()).toBeNull()
}

async function writeStoresTheChange(store: Store): Promise<void> {
  await store.write(newRun)
  expect(await store.read()).toEqual(newRun())
}

async function writeChangesTheStoredRun(store: Store): Promise<void> {
  await store.write(newRun)
  await store.write(nextRevision)
  expect((await store.read())?.revision).toBe(newRun().revision + 1)
}

async function nullRemovesTheRun(store: Store): Promise<void> {
  await store.write(newRun)
  await store.write(() => null)
  expect(await store.read()).toBeNull()
}

async function writesAtOnceLoseNone(store: Store): Promise<void> {
  await store.write(newRun)
  await Promise.all([store.write(nextRevision), store.write(nextRevision), store.write(nextRevision)])
  expect((await store.read())?.revision).toBe(newRun().revision + 3)
}

async function failedChangeStoresNothing(store: Store): Promise<void> {
  await store.write(newRun)
  await expect(store.write(failingChange)).rejects.toThrow('the change failed')
  expect(await store.read()).toEqual(newRun())
}

async function factsStandApart(store: Store): Promise<void> {
  await store.write(newRun)
  await store.writeFacts(FACTS)
  expect(await store.read()).toEqual(newRun())
  await store.write(() => null)
  expect(await store.readFacts()).toEqual(FACTS)
  await store.writeFacts(null)
  expect(await store.readFacts()).toBeNull()
}

/** What every Store must do, whatever keeps the run: the memory of a test, the state of the session, SQLite or Postgres. */
export const STORE_CHECKS: [string, (store: Store) => Promise<void>][] = [
  ['an empty store reads no run and no facts', emptyStore],
  ['a write stores the run that its change returns', writeStoresTheChange],
  ['a write gives its change the stored run', writeChangesTheStoredRun],
  ['a change that returns null removes the run', nullRemovesTheRun],
  ['writes at one time lose none', writesAtOnceLoseNone],
  ['a change that fails stores nothing, and its write rejects', failedChangeStoresNothing],
  ['the facts stand apart from the run', factsStandApart],
]
