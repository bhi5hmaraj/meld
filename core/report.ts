import type { Entry, Run } from '../types'
import { collaborationOf, efficiencyOf, progressOf, sharedContextOf, workloadOf } from './metrics'

/**
 * The report of section 3.5 of docs/design/pane-metrics-logs.md: a story in five sentences, the time, progress and cost
 * of the run, how the agents worked together, and one line for each worker.
 */
export type Report = { story: string; run: string[]; team: string[]; workers: string[] }

const MINUTE = 60_000

function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`
}

function minutes(ms: number): string {
  return `${Math.round(ms / MINUTE)}m`
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`
}

export function tokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(Math.round(tokens))
}

/** The report fills fixed templates with the metrics of section 4, so it makes no model call and reads the same on every surface. */
export function reportOf(run: Run, now: number, events: readonly Entry[] = run.log): Report {
  const efficiency = efficiencyOf(run, now, events)
  const progress = progressOf(run, now, events)
  const together = collaborationOf(run, now, events)
  const context = sharedContextOf(run, now, events)
  const workload = workloadOf(run, now, events)
  const top = workload.shares.reduce<(typeof workload.shares)[number] | undefined>((best, one) => (!best || one.share > best.share ? one : best), undefined)
  const story = [
    `${plural(run.workers.length, 'agent')} finished ${plural(progress.done, 'task')} in ${plural(Math.round(efficiency.runMs / MINUTE), 'minute')}.`,
    `For ${Math.round(efficiency.aloneMs / MINUTE)} of those minutes, only one agent worked.`,
    progress.done && top ? `${top.worker} did ${percent(top.share)} of the work.` : 'No agent finished a task.',
    context.all ? `${context.delivered} of ${context.all} entries reached another agent.` : 'No agent shared an entry.',
    `${efficiency.checks ? `${efficiency.failedChecks} of ${plural(efficiency.checks, 'check')} failed` : 'No check ran'}, and the person ${together.steers ? `steered ${plural(together.steers, 'time')}` : 'did not steer'}.`,
  ].join(' ')
  const all = progress.done + progress.working + progress.ready + progress.waiting
  const mix = workload.agentMix.map(kind => `${kind.type} did ${percent(kind.share)} of the work with rework ${kind.rework.toFixed(2)}`).join('; ')
  return {
    story,
    run: [
      `Time: ${minutes(efficiency.runMs)} of run, ${minutes(efficiency.workerMs)} of agent time, busy ${percent(efficiency.busyShare)}, parallelism ${efficiency.parallelism.toFixed(1)}, one agent alone ${minutes(efficiency.aloneMs)}, waiting on meld ${minutes(efficiency.waitingMs)}, asleep ${minutes(efficiency.asleepMs)}, idle restarts ${efficiency.idleRestarts}.`,
      `Progress: ${progress.done} of ${plural(all, 'task')} done, weight ${progress.doneWeight} of ${progress.allWeight}, ready with no agent ${minutes(progress.readyNoAgent.ms)}, scope growth ${progress.scopeGrowth.toFixed(2)}, critical path left ${plural(progress.criticalPath.tasks, 'task')}, ${progress.blocked.count} blocked, task time ${minutes(progress.taskMs)}.`,
      `Cost: ${tokenCount(efficiency.costUnits)} tokens, ${tokenCount(efficiency.costPerTask)} for each finished task, cache reads ${percent(efficiency.cacheReadShare)} of the cost, rework ${efficiency.rework.toFixed(2)} for each task, ${efficiency.failedChecks} of ${plural(efficiency.checks, 'check')} failed.`,
    ],
    team: [
      `Together: cross needs ${together.crossNeeds} of ${together.withNeeds}, handovers used ${together.handoversUsed}, commits taken ${together.commitsTaken}, splits for others ${together.splitsForOthers}, conflicts ${together.conflicts}, ${plural(together.overlap.length, 'file')} changed by two agents, ${plural(together.steers, 'steer')} (${together.steersForMeld} doing the work of meld).`,
      `Shared context: ${plural(context.entries.fact, 'fact')}, ${plural(context.entries.fail, 'fail')}, ${plural(context.entries.interface, 'interface')}; ${context.delivered} of ${context.all} reached another agent, in ${minutes(context.deliveryMs)}; ${context.cited} of ${context.received} cited; ${context.failsHeeded} of ${context.failsReceived} fails heeded; ${context.repeatedFails} repeated.`,
      `Workload: balance ${workload.balance.toFixed(2)}, spread ${workload.spread.toFixed(2)}, largest task ${percent(workload.largestTaskShare)} of the weight${mix ? `; ${mix}` : ''}.`,
    ],
    workers: efficiency.workers.map((worker, index) => {
      const share = workload.shares[index]?.share ?? 0
      const idle = workload.idleWhileOthersWork[index]?.ms ?? 0
      return `${worker.worker}: busy ${minutes(worker.busyMs)} of ${minutes(worker.workerMs)}, ${percent(share)} of the work, ${minutes(idle)} idle while others worked, ${tokenCount(worker.costUnits)} tokens.`
    }),
  }
}
