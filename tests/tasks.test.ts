import { expect, test } from 'claude-code/testing'

import { childrenOf, claimable, isParent, isReady, waitsFor, waitsOn } from '../hooks/tasks'
import type { Task } from '../types'

function task(id: number, fields: Partial<Task> = {}): Task {
  return { id, title: `Task ${id}`, detail: '', state: 'open', version: 1, ...fields }
}

const TREE: Task[] = [
  task(1),
  task(2, { parent: 1, state: 'done', owner: 'w1' }),
  task(3, { parent: 1, state: 'claimed', owner: 'w2' }),
  task(4, { needs: [2, 1] }),
  task(5, { parent: 4 }),
  task(6, { needs: [2] }),
  task(7),
]

test('the children of a task are the tasks that name it as their parent', () => {
  expect(childrenOf(TREE, 1).map(one => one.id)).toEqual([2, 3])
  expect(childrenOf(TREE, 7)).toEqual([])
})

test('a task with children is a parent', () => {
  expect(isParent(TREE, 1)).toBe(true)
  expect(isParent(TREE, 3)).toBe(false)
})

test('a task waits for its first need that is not done', () => {
  expect(waitsFor(TREE, task(4, { needs: [2, 1] }))).toBe(1)
  expect(isReady(TREE, task(4, { needs: [2, 1] }))).toBe(false)
})

test('a task waits for a need of its ancestors', () => {
  expect(waitsFor(TREE, task(5, { parent: 4 }))).toBe(1)
})

test('a task whose needs are done is ready', () => {
  expect(waitsFor(TREE, task(6, { needs: [2] }))).toBeUndefined()
  expect(isReady(TREE, task(6, { needs: [2] }))).toBe(true)
})

test('a task with no needs, as meld 0.6.0 stored it, is ready', () => {
  expect(isReady(TREE, task(7))).toBe(true)
})

test('a need of a task that is not on the board does not hold a task back', () => {
  expect(waitsFor(TREE, task(8, { needs: [42] }))).toBeUndefined()
})

test('a parent chain with a loop ends', () => {
  const loop = [task(1, { parent: 2 }), task(2, { parent: 1 })]
  expect(waitsFor(loop, task(2, { parent: 1 }))).toBeUndefined()
})

test('the claimable tasks are the open leaves that are ready', () => {
  expect(claimable(TREE).map(one => one.id)).toEqual([6, 7])
})

test('a task waits on a task through its needs, its parts and the needs of its ancestors', () => {
  expect(waitsOn(TREE, 4, [1])).toBe(1)
  expect(waitsOn(TREE, 1, [3])).toBe(3)
  expect(waitsOn(TREE, 5, [1])).toBe(1)
  expect(waitsOn(TREE, 7, [1])).toBeUndefined()
})

test('a task waits on itself', () => {
  expect(waitsOn(TREE, 1, [1])).toBe(1)
})
