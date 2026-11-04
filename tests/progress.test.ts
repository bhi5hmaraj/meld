import { expect, test } from 'claude-code/testing'

import { ownersOf, partsOf, percentLabel, percentOf, requestParts, requestPercent, SIZE_WEIGHT, topTasks, weightOf } from '../core/progress'
import type { Task } from '../types'

function task(id: number, fields: Partial<Task> = {}): Task {
  return { id, title: `Task ${id}`, detail: '', state: 'open', version: 1, ...fields }
}

/** A number to six places: two sums of the same shares can differ in the last digits. */
function rounded(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/** #1 is an L parent of an S part that is done, an L part that w2 claims and an M part that is open. */
const TREE: Task[] = [
  task(1, { size: 'L' }),
  task(2, { parent: 1, size: 'S', state: 'done', owner: 'w1' }),
  task(3, { parent: 1, size: 'L', state: 'claimed', owner: 'w2' }),
  task(4, { parent: 1 }),
  task(5, { size: 'S', state: 'done', owner: 'w3' }),
  task(6, { needs: [1] }),
]

/** #1 has an L part #2 with two M parts, one done and one claimed, and an S part #3 with one claimed part. */
const DEEP: Task[] = [
  task(1),
  task(2, { parent: 1, size: 'L' }),
  task(3, { parent: 1, size: 'S' }),
  task(4, { parent: 2, state: 'done', owner: 'w1' }),
  task(5, { parent: 2, state: 'claimed', owner: 'w3' }),
  task(6, { parent: 3, state: 'claimed', owner: 'w1' }),
]

test('a size weighs 1, 3 or 8, and a task with no size weighs as M', () => {
  expect(SIZE_WEIGHT).toEqual({ S: 1, M: 3, L: 8 })
  expect(weightOf(task(1, { size: 'S' }))).toBe(1)
  expect(weightOf(task(1, { size: 'L' }))).toBe(8)
  expect(weightOf(task(1))).toBe(3)
})

test('a leaf is at 0 percent until a worker finishes it, and at 100 after that', () => {
  const tasks = [task(1), task(2, { state: 'claimed', owner: 'w1' }), task(3, { state: 'done', owner: 'w1' })]
  expect(tasks.map(one => percentOf(tasks, one))).toEqual([0, 0, 100])
})

test('a parent is the size-weighted mean of its children', () => {
  expect(rounded(percentOf(TREE, task(1, { size: 'L' })))).toBe(rounded(100 / 12))
})

test('a parent of parents takes the percent of each child, not the count of its leaves', () => {
  expect(percentOf(DEEP, task(2, { parent: 1, size: 'L' }))).toBe(50)
  expect(rounded(percentOf(DEEP, task(1)))).toBe(rounded((8 * 50) / 9))
})

test('the parent state on the board does not change its percent', () => {
  expect(rounded(percentOf(TREE, task(1, { size: 'L', state: 'done' })))).toBe(rounded(100 / 12))
})

test('a parent is at 100 percent when all its children are done', () => {
  const tasks = [task(1), task(2, { parent: 1, size: 'S', state: 'done' }), task(3, { parent: 1, size: 'L', state: 'done' }), task(4, { parent: 1, state: 'done' })]
  expect(percentOf(tasks, task(1))).toBe(100)
})

test('the request is the size-weighted mean of the top-level tasks', () => {
  expect(rounded(requestPercent(TREE))).toBe(rounded((8 * (100 / 12) + 100) / 12))
})

test('a request with no tasks is at 0 percent', () => {
  expect(requestPercent([])).toBe(0)
  expect(requestParts([])).toEqual({ done: 0, claimed: 0, open: 0 })
})

test('the top-level tasks are the tasks with no parent', () => {
  expect(topTasks(TREE).map(one => one.id)).toEqual([1, 5, 6])
})

test('the parts of a task are its done, claimed and open shares, weighted as its percent', () => {
  const parts = partsOf(DEEP, task(1))
  expect(rounded(parts.done)).toBe(rounded(4 / 9))
  expect(rounded(parts.claimed)).toBe(rounded(4 / 9 + 1 / 9))
  expect(parts.open).toBe(0)
  expect(partsOf(TREE, task(4, { parent: 1 }))).toEqual({ done: 0, claimed: 0, open: 1 })
})

test('the parts of the request add up the top-level tasks by their size', () => {
  const parts = requestParts(TREE)
  expect(rounded(parts.done)).toBe(rounded((8 / 12) * (1 / 12) + 1 / 12))
  expect(rounded(parts.claimed)).toBe(rounded((8 / 12) * (8 / 12)))
  expect(rounded(parts.open)).toBe(rounded((8 / 12) * (3 / 12) + 3 / 12))
})

test('the owners of a task are the workers that claim its leaves, each one time and in worker order', () => {
  expect(ownersOf(DEEP, task(1))).toEqual(['w1', 'w3'])
  expect(ownersOf(TREE, task(1, { size: 'L' }))).toEqual(['w2'])
})

test('a leaf that is done or open has no owner dots', () => {
  expect(ownersOf(TREE, task(5, { size: 'S', state: 'done', owner: 'w3' }))).toEqual([])
  expect(ownersOf(TREE, task(6, { needs: [1] }))).toEqual([])
})

test('a percent shows as the whole number at or below it, so 100% means that all is done', () => {
  expect(percentLabel(100)).toBe('100%')
  expect(percentLabel(99.9)).toBe('99%')
  expect(percentLabel(100 * 0.29)).toBe('29%')
  expect(percentLabel(0)).toBe('0%')
})

test('a task that meld 0.6.0 stored, with no size and no parent, is a top-level M task', () => {
  const stored = [{ id: 1, title: 'Theme tokens', detail: '', state: 'done', owner: 'w1', version: 3, commit: 'def5678', summary: 'Tokens added' }, { id: 2, title: 'Toggle', detail: '', state: 'open', version: 1 }] as Task[]
  expect(topTasks(stored).map(one => one.id)).toEqual([1, 2])
  expect(requestPercent(stored)).toBe(50)
})
