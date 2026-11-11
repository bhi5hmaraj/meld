import type { Task, TaskSize, WorkerId } from '../types'
import { childrenOf } from './tasks'

export const SIZE_WEIGHT: Readonly<Record<TaskSize, number>> = { S: 1, M: 3, L: 8 }

/** The shares of the work of a task that are done, claimed and open. Each child counts by its size, as in the percent. */
export type Parts = { done: number; claimed: number; open: number }

const NO_PARTS: Parts = { done: 0, claimed: 0, open: 0 }
/** Lets a sum of shares that is 29 percent in floating point show as 29, not 28. */
const ROUNDING = 1e-9

export function weightOf(task: Task): number {
  return SIZE_WEIGHT[task.size ?? 'M']
}

export function topTasks(tasks: readonly Task[]): Task[] {
  return tasks.filter(task => task.parent === undefined)
}

/** A leaf is one part, done, claimed or open, from its state on the board. A parent is the size-weighted mean of its children. */
export function partsOf(tasks: readonly Task[], task: Task): Parts {
  const children = childrenOf(tasks, task.id)
  if (!children.length) return { done: task.state === 'done' ? 1 : 0, claimed: task.state === 'claimed' ? 1 : 0, open: task.state === 'open' ? 1 : 0 }
  return meanOf(tasks, children)
}

export function requestParts(tasks: readonly Task[]): Parts {
  return meanOf(tasks, topTasks(tasks))
}

export function requestPercent(tasks: readonly Task[]): number {
  return 100 * requestParts(tasks).done
}

/** The percent as the whole number at or below it, so 100% means that all the work is done. */
export function percentLabel(percent: number): string {
  return `${floored(percent)}%`
}

/** The whole number at or below the value, when the value is a sum of shares in floating point. */
export function floored(value: number): number {
  return Math.floor(value + ROUNDING)
}

/** The workers that claim a leaf of the task, or the task when it is a leaf, each one time. */
export function ownersOf(tasks: readonly Task[], task: Task): WorkerId[] {
  const owners = leavesOf(tasks, task).flatMap(leaf => (leaf.state === 'claimed' && leaf.owner ? [leaf.owner] : []))
  return [...new Set(owners)].sort()
}

/** The sum of each member's parts times its weight, divided one time by the total weight: all parts done is 1, not 0.9999. */
function meanOf(tasks: readonly Task[], members: readonly Task[]): Parts {
  const total = members.reduce((sum, member) => sum + weightOf(member), 0)
  if (!total) return NO_PARTS
  const sums = members.reduce((sum, member) => {
    const parts = partsOf(tasks, member)
    const weight = weightOf(member)
    return { done: sum.done + weight * parts.done, claimed: sum.claimed + weight * parts.claimed, open: sum.open + weight * parts.open }
  }, NO_PARTS)
  return { done: sums.done / total, claimed: sums.claimed / total, open: sums.open / total }
}

/** The leaves under the task, or the task when it is a leaf. */
export function leavesOf(tasks: readonly Task[], task: Task): Task[] {
  const children = childrenOf(tasks, task.id)
  return children.length ? children.flatMap(child => leavesOf(tasks, child)) : [task]
}
