import type { ElementTable, RenderSurface } from 'claude-code'

import type { Entry, Run, RunState, Task } from '../types'
import { deliver, discard, steerRun, stopAll, stopOne } from './actions'
import { steersOf } from './board'
import type { Io } from './io'

export const PANE = 'meld'

const TASK_ROWS = 12
const LOG_ROWS = 8
const LIVE = new Set<RunState>(['starting', 'working', 'ready'])
const STATE_COLOR: Record<RunState, string> = {
  starting: 'warning',
  working: 'success',
  ready: 'suggestion',
  delivered: 'inactive',
  stopped: 'error',
}
const TASK_COLOR: Record<Task['state'], string | undefined> = { open: undefined, claimed: 'warning', done: 'success' }

export function paneTree(table: ElementTable, surface: RenderSurface, run: Run | null, now: number, io: Io) {
  const { Box, Text, Button } = table
  const Input = 'Input' in table ? table.Input : undefined

  if (!run) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>meld</Text>
        <Text dimColor>No run. Start one with /meld followed by the task.</Text>
      </Box>
    )
  }

  const live = LIVE.has(run.state)
  const steers = steersOf(run)
  const tasks = run.tasks.slice(-TASK_ROWS)
  const log = run.log.slice(-LOG_ROWS)

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Text bold>meld {run.id}</Text>
        <Text color={STATE_COLOR[run.state]}>{run.state}</Text>
        <Text dimColor>
          revision {run.revision} · {ago(now - run.startedAt)} · from {run.base.slice(0, 7)}
        </Text>
      </Box>

      <Box flexDirection="column">
        <Text wrap="wrap">{run.request}</Text>
        {steers.map((steer, index) => (
          <Box key={`steer-${index}`}>
            <Text dimColor wrap="wrap">
              steer {index + 1}: {steer}
            </Text>
          </Box>
        ))}
      </Box>

      <Box flexDirection="column">
        <Text bold>Workers</Text>
        {run.workers.map(worker => (
          <Box key={worker.id} flexDirection="row" gap={1} flexWrap="wrap">
            <Text bold>{worker.id}</Text>
            <Text color={worker.state === 'stopped' ? 'error' : worker.state === 'working' ? 'success' : 'inactive'}>{worker.state}</Text>
            <Text wrap="truncate-end">{worker.activity}</Text>
            <Text dimColor>
              {ago(now - worker.activityAt)} · {worker.branch}
              {run.integrator === worker.id ? ' · integrates' : ''}
            </Text>
            {live && worker.state !== 'stopped' && (
              <Button key={`stop-${worker.id}`} onPress={() => void act(io, () => stopOne(io, worker.id))}>
                Stop {worker.id}
              </Button>
            )}
          </Box>
        ))}
      </Box>

      <Box flexDirection="column">
        <Text bold>Tasks</Text>
        {tasks.length === 0 && <Text dimColor>No tasks yet.</Text>}
        {tasks.map(task => (
          <Box key={`task-${task.id}`} flexDirection="row" gap={1}>
            <Text color={TASK_COLOR[task.state]}>
              #{task.id} {task.state}
            </Text>
            <Text dimColor>{task.owner ?? '—'}</Text>
            <Text wrap="truncate-end">
              {task.title}
              {task.commit ? ` · ${task.commit.slice(0, 7)}` : ''}
            </Text>
          </Box>
        ))}
      </Box>

      <Box flexDirection="column">
        <Text bold>Log</Text>
        {log.length === 0 && <Text dimColor>Nothing yet.</Text>}
        {log.map(entry => (
          <Box key={`entry-${entry.id}`} flexDirection="row" gap={1}>
            <Text dimColor>{ago(now - entry.at)}</Text>
            <Text bold>{entry.by}</Text>
            <Text color={entryColor(entry)} wrap="truncate-end">
              {entryText(entry)}
            </Text>
          </Box>
        ))}
      </Box>

      {run.final && (
        <Box flexDirection="column">
          <Text bold>Result</Text>
          <Text wrap="wrap">
            {run.final.commit.slice(0, 7)} by {run.final.by}: {run.final.summary}
          </Text>
        </Box>
      )}

      {live && Input && (
        <Input
          key="steer"
          label={run.state === 'ready' ? 'Ask for changes' : 'Steer both workers'}
          placeholder="A new instruction for both workers"
          submitLabel="Steer"
          onSubmit={value => void act(io, () => steerRun(io, value.trim()))}
        />
      )}
      {live && (!Input || surface === 'mobile') && <Text dimColor>To steer, send /meld-steer followed by the instruction.</Text>}

      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {run.state === 'ready' && (
          <Button key="deliver" variant="primary" onPress={() => void act(io, () => deliver(io))}>
            Deliver into your branch
          </Button>
        )}
        {(run.state === 'starting' || run.state === 'working') && (
          <Button key="stop" onPress={() => void act(io, () => stopAll(io))}>
            Stop the run
          </Button>
        )}
        <Button key="discard" onPress={() => void act(io, () => discard(io))}>
          {run.state === 'delivered' ? 'Clear' : 'Discard'}
        </Button>
      </Box>

      <Text dimColor wrap="wrap">
        What you type in the chat goes to Claude, not to the workers. Steer the workers here or with /meld-steer.
      </Text>
    </Box>
  )
}

async function act(io: Io, action: () => Promise<string>): Promise<void> {
  io.toast(await action())
}

function entryText(entry: Entry): string {
  if (entry.kind === 'check') return `${entry.passed ? 'passed' : 'failed'}: ${entry.text}${entry.commit ? ` @${entry.commit.slice(0, 7)}` : ''}`
  if (entry.kind === 'steer') return `steer ${entry.revision}: ${entry.text}`
  return entry.text
}

function entryColor(entry: Entry): string | undefined {
  if (entry.kind === 'check') return entry.passed ? 'success' : 'error'
  if (entry.kind === 'steer') return 'suggestion'
  return undefined
}

function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${Math.round(seconds / 3600)}h`
}
