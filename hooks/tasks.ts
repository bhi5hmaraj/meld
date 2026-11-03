import type { Task } from '../types'

export function childrenOf(tasks: readonly Task[], id: number): Task[] {
  return tasks.filter(task => task.parent === id)
}

export function isParent(tasks: readonly Task[], id: number): boolean {
  return tasks.some(task => task.parent === id)
}

/**
 * The need that holds the task back. The needs of the task come before the needs of its ancestors, as a part of a
 * parent waits for what the parent waits for. A need that names no task of the board holds nothing back.
 */
export function waitsFor(tasks: readonly Task[], task: Task): number | undefined {
  const seen = new Set<number>()
  for (let current: Task | undefined = task; current && !seen.has(current.id); current = taskOf(tasks, current.parent)) {
    seen.add(current.id)
    const need = current.needs?.find(id => isNotDone(taskOf(tasks, id)))
    if (need !== undefined) return need
  }
  return undefined
}

export function isReady(tasks: readonly Task[], task: Task): boolean {
  return waitsFor(tasks, task) === undefined
}

/**
 * The first of the targets that the task waits on: through its needs, its parts, and the needs of its ancestors. A
 * new task that needs a task that waits on its ancestors makes a loop that no worker can finish.
 */
export function waitsOn(tasks: readonly Task[], id: number, targets: readonly number[]): number | undefined {
  const seen = new Set<number>()
  const queue = [id]
  for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
    if (targets.includes(current)) return current
    const task = taskOf(tasks, current)
    if (seen.has(current) || !task) continue
    seen.add(current)
    queue.push(...(task.needs ?? []), ...childrenOf(tasks, current).map(child => child.id), ...ancestorNeeds(tasks, task))
  }
  return undefined
}

/** The tasks that a worker can claim now: open, with no children, and ready. */
export function claimable(tasks: readonly Task[]): Task[] {
  return tasks.filter(task => task.state === 'open' && !isParent(tasks, task.id) && isReady(tasks, task))
}

export function taskOf(tasks: readonly Task[], id: number | undefined): Task | undefined {
  return id === undefined ? undefined : tasks.find(task => task.id === id)
}

function ancestorNeeds(tasks: readonly Task[], task: Task): number[] {
  const needs: number[] = []
  const seen = new Set([task.id])
  for (let current = taskOf(tasks, task.parent); current && !seen.has(current.id); current = taskOf(tasks, current.parent)) {
    seen.add(current.id)
    needs.push(...(current.needs ?? []))
  }
  return needs
}

function isNotDone(task: Task | undefined): boolean {
  return task !== undefined && task.state !== 'done'
}
