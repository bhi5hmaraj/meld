import { expect, test } from 'claude-code/testing'

import { addTasks, bindWorker, claimTask, finishTask, isFailure, releaseTask, splitTask, startRun, stopWorker } from '../core/board'
import { childrenOf, claimable, isParent, isReady, taskOf } from '../core/tasks'
import type { Change, NewTask, Run, Task, TaskSize, WorkerId } from '../types'
import { HEAD } from './fake-io'

const NOW = 1_800_000_000_000
const COMMIT = 'f'.repeat(40)
const WORKERS: WorkerId[] = ['w1', 'w2', 'w3']
const SIZES: TaskSize[] = ['S', 'M', 'L']
const SEEDS = 200
const STEPS = 60
const STOP_CHANCE = 0.01
const KINDS = [' adds tasks', ' claims #', ' releases #', ' finishes #', ' splits #', 'stop ']
const FRESH_CHANCE = 0.9

/** A seeded source of numbers (mulberry32), so that a broken rule shows again with its seed. */
class Dice {
  private state: number

  constructor(seed: number) {
    this.state = seed
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0
    let mixed = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }

  below(count: number): number {
    return Math.floor(this.next() * count)
  }

  chance(odds: number): boolean {
    return this.next() < odds
  }

  pick<T>(items: readonly T[]): T | undefined {
    return items[this.below(items.length)]
  }
}

type Step = { op: string; run: Run }

/** One seed played: the calls, the run at the end, and the first rule that a call broke. */
type Play = { ops: string[]; run: Run; broken?: string }

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

function working(): Run {
  const workers = WORKERS.map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: `meld/r1/${id}`, agent: { type: 'meld:worker' } }))
  let run = startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: HEAD, vcs: 'git', now: NOW, workers })
  for (const [index, id] of WORKERS.entries()) run = runOf(bindWorker(run, id, `agent-${index + 1}`, NOW))
  return run
}

/** The run after a change, or the run as it was when the board refused the change. */
function applied<T>(op: string, run: Run, change: Change<T>): Step {
  return isFailure(change) ? { op: `${op} (refused: ${change.error})`, run } : { op, run: change.run }
}

/** One to three new tasks, each with a parent and needs that can name any task of the board, or none. */
function newTasks(run: Run, dice: Dice): NewTask[] {
  const count = 1 + dice.below(3)
  const ids = run.tasks.map(task => task.id)
  return Array.from({ length: count }, (_, index) => ({
    title: `task ${run.tasks.length + index + 1}`,
    size: dice.pick(SIZES),
    parent: dice.chance(0.3) ? dice.pick(ids) : undefined,
    needs: dice.chance(0.4) ? [dice.pick(ids) ?? 1] : undefined,
  }))
}

/** A version that is current, or one behind, as a stale read gives. */
function versionOf(task: Task | undefined, dice: Dice): number {
  return (task?.version ?? 1) - (dice.chance(FRESH_CHANCE) ? 0 : 1)
}

/** A random call of a random worker, a stopped worker too: an agent can still call the board after its stop. */
function step(run: Run, dice: Dice, now: number): Step {
  const by = dice.pick(WORKERS) ?? 'w1'
  if (dice.chance(STOP_CHANCE)) return { op: `stop ${by}`, run: stopWorker(run, by, now) }
  const owned = run.tasks.filter(task => task.state === 'claimed' && task.owner === by)
  const mine = dice.chance(0.8) ? dice.pick(owned) : dice.pick(run.tasks)
  const id = mine?.id ?? 1
  const choice = dice.below(5)
  if (choice === 0) {
    const seen = dice.chance(FRESH_CHANCE) ? run.taskList : run.taskList - 1
    return applied(`${by} adds tasks`, run, addTasks(run, by, { seen, tasks: newTasks(run, dice) }, now))
  }
  if (choice === 1) {
    const task = dice.chance(0.8) ? dice.pick(claimable(run.tasks)) : dice.pick(run.tasks)
    const claimed = task?.id ?? 1
    return applied(`${by} claims #${claimed}`, run, claimTask(run, by, claimed, versionOf(task, dice), now))
  }
  if (choice === 2) return applied(`${by} releases #${id}`, run, releaseTask(run, by, id, versionOf(mine, dice), '', now))
  if (choice === 3) return applied(`${by} finishes #${id}`, run, finishTask(run, by, id, versionOf(mine, dice), COMMIT, 'done', now))
  const parts = newTasks(run, dice).map(part => ({ ...part, parent: undefined }))
  const split = { task: id, version: versionOf(mine, dice), seen: run.taskList, tasks: [...parts, { title: 'last part' }] }
  return applied(`${by} splits #${id}`, run, splitTask(run, by, split, now))
}

/** The tasks that a task waits for: its needs, its parts, and the needs of its parents. */
function waitsOf(tasks: readonly Task[], task: Task): number[] {
  const waits = [...(task.needs ?? []), ...childrenOf(tasks, task.id).map(part => part.id)]
  for (let parent = taskOf(tasks, task.parent); parent; parent = taskOf(tasks, parent.parent)) waits.push(...(parent.needs ?? []))
  return waits
}

/** A task that waits for itself through its needs, parts and parents, as a chain of ids; undefined when there is none. */
function loopOf(tasks: readonly Task[]): string | undefined {
  for (const start of tasks) {
    const path = [start.id]
    const queue = waitsOf(tasks, start).map(id => [...path, id])
    const seen = new Set<number>()
    for (let chain = queue.shift(); chain; chain = queue.shift()) {
      const last = chain[chain.length - 1] ?? 0
      if (last === start.id) return chain.map(id => `#${id}`).join(' → ')
      const task = taskOf(tasks, last)
      if (!task || seen.has(last)) continue
      seen.add(last)
      queue.push(...waitsOf(tasks, task).map(id => [...chain, id]))
    }
  }
  return undefined
}

function stateOf(run: Run, id: WorkerId | undefined): string | undefined {
  return run.workers.find(worker => worker.id === id)?.state
}

/** The first rule of the board that a step broke, from the run before it to the run after it. */
function brokenRule(before: Run, after: Run): string | undefined {
  if (new Set(after.tasks.map(task => task.id)).size !== after.tasks.length) return 'two tasks have one id'
  if (after.taskList < before.taskList) return `the task list went back from ${before.taskList} to ${after.taskList}`
  for (const task of after.tasks) {
    const old = taskOf(before.tasks, task.id)
    const parts = childrenOf(after.tasks, task.id)
    if (task.state === 'claimed' && !task.owner) return `#${task.id} is claimed with no owner`
    if (task.state === 'open' && task.owner) return `#${task.id} is open with the owner ${task.owner}`
    if (task.state === 'claimed' && isParent(after.tasks, task.id)) return `#${task.id} has parts and the owner ${task.owner}`
    if (task.state === 'claimed' && !isReady(after.tasks, task)) return `#${task.id} is claimed and waits for a need`
    if (task.state === 'claimed' && stateOf(after, task.owner) === 'stopped') return `#${task.id} is claimed by the stopped worker ${task.owner}`
    if (parts.length && (task.state === 'done') !== parts.every(part => part.state === 'done')) return `#${task.id} is ${task.state}, and ${parts.filter(part => part.state === 'done').length} of its ${parts.length} parts are done`
    if (old && task.version < old.version) return `#${task.id} went back from version ${old.version} to ${task.version}`
    if (old && (old.state !== task.state || old.owner !== task.owner) && task.version === old.version) return `#${task.id} changed from ${old.state} to ${task.state} with no new version`
    if (old?.state === 'claimed' && task.state === 'claimed' && old.owner !== task.owner) return `#${task.id} went from ${old.owner} to ${task.owner} with no release`
    if (old?.state === 'done' && task.state !== 'done') return `#${task.id} was done and is ${task.state}`
  }
  const loop = loopOf(after.tasks)
  return loop ? `the needs make a loop: ${loop}` : undefined
}

/** Plays one seed to its end, or to the first broken rule, which names the seed, the step and the calls before it. */
function play(seed: number): Play {
  const dice = new Dice(seed)
  const ops: string[] = []
  let run = working()
  for (let index = 0; index < STEPS; index++) {
    const next = step(run, dice, NOW + index)
    ops.push(next.op)
    const broken = brokenRule(run, next.run)
    if (broken) return { ops, run, broken: `seed ${seed}, step ${index + 1}: ${broken}, after ${ops.slice(-5).join('; ')}` }
    run = next.run
  }
  return { ops, run }
}

function plays(): Play[] {
  return Array.from({ length: SEEDS }, (_, index) => play(index + 1))
}

function hasDoneParent(run: Run): boolean {
  return run.tasks.some(task => task.state === 'done' && isParent(run.tasks, task.id))
}

test('random calls of the workers keep the rules of the board: one owner, parents done with their parts, no loop of needs, versions that grow', () => {
  expect(plays().flatMap(one => (one.broken ? [one.broken] : [])).slice(0, 3)).toEqual([])
})

test('the random calls make each kind of change, and parents get done', () => {
  const played = plays()
  const made = played.flatMap(one => one.ops).filter(op => !op.includes('refused'))
  for (const kind of KINDS) expect(made.filter(op => op.includes(kind)).length).toBeGreaterThan(50)
  expect(played.filter(one => hasDoneParent(one.run)).length).toBeGreaterThan(10)
})
