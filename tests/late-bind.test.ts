import { expect, test } from 'claude-code/testing'

import { addWorker, markWorker, steerRun } from '../hooks/actions'
import { bindWorker, declareFinal, isFailure, startRun, takeIntegration } from '../hooks/board'
import type { SpawnArgs, Spawned } from '../hooks/io'
import type { Change, Run, WorkerId } from '../types'
import { FakeIo, HEAD } from './fake-io'

const NOW = 1_800_000_000_000
const FINAL = 'f'.repeat(40)

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

/** Two workers at work, and w1 integrates: agent-1 runs w1, agent-2 runs w2. */
function integrating(): Run {
  const ids: WorkerId[] = ['w1', 'w2']
  const workers = ids.map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: `meld/r1/${id}`, agent: { type: 'meld:worker' } }))
  let run = startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers })
  for (const [index, id] of ids.entries()) run = runOf(bindWorker(run, id, `agent-${index + 1}`, NOW))
  return runOf(takeIntegration(run, 'w1', NOW))
}

/**
 * The integrator declares the final commit while the engine starts the agent of a worker that the person added: the
 * run is ready when meld binds that agent, and a ready run binds no agent.
 */
class FinalDuringSpawn extends FakeIo {
  override async spawn(args: SpawnArgs): Promise<Spawned> {
    if (this.current?.state === 'working') this.current = runOf(declareFinal(this.current, 'w1', FINAL, 'A dark theme', NOW))
    return super.spawn(args)
  }
}

test('a worker whose agent meld cannot bind, as the run became ready during its spawn, is refused as a denied spawn is', async () => {
  const io = new FinalDuringSpawn()
  io.current = integrating()
  const replied = await addWorker(io, '')
  expect(replied).toBe('w3 joined the run, but its agent did not start: the run is ready.')
  expect(io.current?.workers.map(worker => worker.state)).toEqual(['working', 'working', 'stopped'])
  expect(io.current?.workers[2]?.agentId).toBeUndefined()
  expect(io.current?.workers[2]?.activity).toBe('not started: the run is ready')
  expect(io.current?.log.map(entry => entry.text)).toContain('w3 did not start: the run is ready')
})

test('a worker that meld could not bind does not stall the run: a steer starts the lead again', async () => {
  const io = new FinalDuringSpawn()
  io.current = integrating()
  await addWorker(io, '')
  await markWorker(io, 'agent-1', 'idle')
  await markWorker(io, 'agent-2', 'idle')
  const replied = await steerRun(io, 'Add a light theme too')
  expect(replied).toBe('Revision 2: meld starts w1 again with it.')
  expect(io.spawned.map(spawn => spawn.description)).toEqual(['meld w3', 'meld w1'])
  expect(io.spawned[1]?.prompt).toContain('The person changed the request (revision 2): Add a light theme too')
})
