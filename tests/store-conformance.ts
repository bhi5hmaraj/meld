import { startRun } from '../core/board'
import type { Store } from '../core/ports'
import type { Facts, Run } from '../types'

/**
 * What every Store must do, whatever keeps the run: the memory of a test, the state of the session, SQLite or Postgres.
 * The checks throw, and import no test runner, so the engine runner and `bun test` both run them.
 */

const HEAD = 'abc1234def5678abc1234def5678abc1234def56'
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

function same(actual: unknown, expected: unknown, what: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what} is ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}`)
}

async function emptyStore(store: Store): Promise<void> {
  same(await store.read(), null, 'the run of an empty store')
  same(await store.readFacts(), null, 'the facts of an empty store')
}

async function writeStoresTheChange(store: Store): Promise<void> {
  await store.write(newRun)
  same(await store.read(), newRun(), 'the stored run')
}

async function writeChangesTheStoredRun(store: Store): Promise<void> {
  await store.write(newRun)
  await store.write(nextRevision)
  same((await store.read())?.revision, newRun().revision + 1, 'the revision after one change')
}

async function nullRemovesTheRun(store: Store): Promise<void> {
  await store.write(newRun)
  await store.write(() => null)
  same(await store.read(), null, 'the run after a change to null')
}

async function writesAtOnceLoseNone(store: Store): Promise<void> {
  await store.write(newRun)
  await Promise.all([store.write(nextRevision), store.write(nextRevision), store.write(nextRevision)])
  same((await store.read())?.revision, newRun().revision + 3, 'the revision after three changes at one time')
}

async function failedChangeStoresNothing(store: Store): Promise<void> {
  await store.write(newRun)
  const failed = await store.write(failingChange).then(
    () => 'stored',
    (error: unknown) => String(error),
  )
  same(failed.includes('the change failed'), true, `a write with a change that fails (${failed}) rejects`)
  same(await store.read(), newRun(), 'the run after a change that failed')
}

async function factsStandApart(store: Store): Promise<void> {
  await store.write(newRun)
  await store.writeFacts(FACTS)
  same(await store.read(), newRun(), 'the run after a write of the facts')
  await store.write(() => null)
  same(await store.readFacts(), FACTS, 'the facts after the run went')
  await store.writeFacts(null)
  same(await store.readFacts(), null, 'the facts after a write of null')
}

export const STORE_CHECKS: [string, (store: Store) => Promise<void>][] = [
  ['an empty store reads no run and no facts', emptyStore],
  ['a write stores the run that its change returns', writeStoresTheChange],
  ['a write gives its change the stored run', writeChangesTheStoredRun],
  ['a change that returns null removes the run', nullRemovesTheRun],
  ['writes at one time lose none', writesAtOnceLoseNone],
  ['a change that fails stores nothing, and its write rejects', failedChangeStoresNothing],
  ['the facts stand apart from the run', factsStandApart],
]
