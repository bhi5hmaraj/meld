import { expect, test } from 'claude-code/testing'

import { leavesOf, partsOf, percentLabel, requestParts, requestPercent, SIZE_WEIGHT, topTasks, weightOf } from '../core/progress'
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

test('the done share of a parent of parents takes the share of each child, not the count of its leaves', () => {
  expect(partsOf(DEEP, task(2, { parent: 1, size: 'L' })).done).toBe(0.5)
  expect(rounded(partsOf(DEEP, task(1)).done)).toBe(rounded((8 * 0.5) / 9))
})

test('the parent state on the board does not change its done share', () => {
  expect(rounded(partsOf(TREE, task(1, { size: 'L', state: 'done' })).done)).toBe(rounded(1 / 12))
})

test('the leaves of a task are the tasks under it with no parts, or the task when it is a leaf', () => {
  expect(leavesOf(DEEP, task(1)).map(one => one.id)).toEqual([4, 5, 6])
  expect(leavesOf(TREE, task(5)).map(one => one.id)).toEqual([5])
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
