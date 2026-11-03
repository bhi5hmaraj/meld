import type { CommandRunResult, ElementTable, RenderSurface } from 'claude-code'

import type { AgentSpec, Entry, Facts, LaneFacts, PaneView, ResultFacts, Run, RunState, Worker, WorkerState } from '../types'
import { deliver, discard, steerRun, stopAll, stopOne } from './actions'
import { STEER_PRESETS } from './contract'
import { agentColor, BAR_HEIGHT, BAR_WIDTH, LANE_HEIGHT, LANE_WIDTH, laneAlt, laneGlyphs, laneSvg, STATUS, taskBarSvg } from './drawing'
import type { TaskCounts } from './drawing'
import type { Io } from './io'
import { agentsOf, MAX_AGENTS, MODELS, WORKER_TYPE } from './options'
import type { StartOptions } from './options'

export const PANE = 'meld'
export const DEFAULT_VIEW: PaneView = { showDiff: false, task: '', agents: 2, model: 'inherit', vcs: 'auto' }

const LIVE = new Set<RunState>(['starting', 'working', 'ready'])
const STATE_WORD: Record<RunState, string> = {
  starting: 'Starting',
  working: 'Working',
  ready: 'Ready to deliver',
  delivered: 'Delivered',
  stopped: 'Stopped',
}
const STATE_TONE: Record<RunState, string> = {
  starting: 'warning',
  working: 'success',
  ready: 'suggestion',
  delivered: 'inactive',
  stopped: 'error',
}
const WORKER_TONE: Record<WorkerState, string> = { starting: 'warning', working: 'success', idle: 'inactive', stopped: 'error' }
const SLOW_MS = 120_000
const STUCK_MS = 300_000
const ACTIVITY_CHARS = 26
const CHECK_CHIPS = 6
const CLAIMED_ROWS = 4
const SUMMARY_WORDS = 24
const AGENT_OPTIONS = Array.from({ length: MAX_AGENTS }, (_, index) => ({ value: String(index + 1), label: `${index + 1}` }))
const MODEL_OPTIONS = [{ value: 'inherit', label: 'Same as this session' }, ...MODELS.map(model => ({ value: model, label: model }))]
const VCS_OPTIONS = [
  { value: 'auto', label: 'jj if installed, else git' },
  { value: 'jj', label: 'jj' },
  { value: 'git', label: 'git' },
]

export type PaneInput = {
  table: ElementTable
  surface: RenderSurface
  run: Run | null
  facts: Facts | null
  view: PaneView
  now: number
  io: Io
  setView: (change: (view: PaneView) => PaneView) => Promise<unknown>
  start: (options: StartOptions) => Promise<CommandRunResult>
}

/** The meld pane: facts the person can check (commits, checks, the diff), and one press for each decision. No block holds more than 100 words. */
export function paneTree(input: PaneInput) {
  const { Box } = input.table
  const run = input.run
  if (!run) return <Box flexDirection="column">{startSection(input)}</Box>
  const facts = input.facts?.run === run.id ? input.facts : null
  return (
    <Box flexDirection="column" gap={1}>
      {headerSection(input, run)}
      {agentsSection(input, run, facts)}
      {tasksSection(input, run)}
      {checksSection(input, run)}
      {run.final && resultSection(input, run, facts?.result)}
      {LIVE.has(run.state) && steerSection(input, run)}
    </Box>
  )
}

function headerSection(input: PaneInput, run: Run) {
  const { Box, Text, Button } = input.table
  const { io } = input
  const tokens = run.workers.reduce((sum, worker) => sum + worker.tokens, 0)
  const shared = sharedSpec(run)
  return (
    <Box key="sec-top" flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
      <Text color={STATE_TONE[run.state]} bold>
        ● {STATE_WORD[run.state]}
      </Text>
      <Text dimColor>
        {run.vcs} · {run.workers.length} agents{shared ? ` · ${shared}` : ''} · {ago(input.now - run.startedAt)} · {formatTokens(tokens)} tokens
      </Text>
      {(run.state === 'starting' || run.state === 'working') && (
        <Button key="stop" onPress={() => void act(io, () => stopAll(io))}>
          ■ Stop all
        </Button>
      )}
      {!LIVE.has(run.state) && (
        <Button key="discard" onPress={() => void act(io, () => discard(io))}>
          {run.state === 'delivered' ? 'Clear' : '✗ Discard'}
        </Button>
      )}
      {run.state === 'ready' && (
        <Button key="discard" dimColor onPress={() => void act(io, () => discard(io))}>
          ✗ Discard
        </Button>
      )}
    </Box>
  )
}

function agentsSection(input: PaneInput, run: Run, facts: Facts | null) {
  const { Box } = input.table
  const checks = run.log.filter(entry => entry.kind === 'check')
  return (
    <Box key="sec-agents" flexDirection="column">
      {run.workers.map((worker, index) => laneRow(input, run, worker, index, laneOf(facts, worker), checks))}
    </Box>
  )
}

function laneRow(input: PaneInput, run: Run, worker: Worker, index: number, lane: LaneFacts, checks: Entry[]) {
  const { Box, Text, Button } = input.table
  const Svg = input.surface !== 'terminal' && 'Svg' in input.table ? input.table.Svg : undefined
  const { io, now } = input
  const marks = { lane, color: index, checks, final: run.final?.commit }
  const age = now - worker.activityAt
  const busy = LIVE.has(run.state) && worker.state === 'working'
  const tone = busy && age > STUCK_MS ? 'error' : busy && age > SLOW_MS ? 'warning' : undefined
  const spec = sharedSpec(run) === undefined ? specLabel(worker.agent) : ''
  return (
    <Box key={`lane-${worker.id}`} flexDirection="row" gap={1} alignItems="center">
      <Text color={WORKER_TONE[worker.state]}>●</Text>
      <Text bold>{worker.id}</Text>
      {Svg ? (
        <Svg source={laneSvg(marks)} alt={laneAlt(worker.id, lane)} width={LANE_WIDTH} height={LANE_HEIGHT} isInteractive />
      ) : (
        <Text color={agentColor(index).light}>{laneGlyphs(marks)}</Text>
      )}
      <Text dimColor wrap="truncate-end">
        {activityOf(run, worker)}
      </Text>
      <Text color={tone} dimColor={!tone}>
        {ago(age)}
      </Text>
      <Text dimColor>{formatTokens(worker.tokens)}</Text>
      {spec && <Text dimColor>{spec}</Text>}
      {LIVE.has(run.state) && worker.state !== 'stopped' && (
        <Button key={`stop-${worker.id}`} dimColor onPress={() => void act(io, () => stopOne(io, worker.id))}>
          ■ Stop
        </Button>
      )}
    </Box>
  )
}

function tasksSection(input: PaneInput, run: Run) {
  const { Box, Text } = input.table
  const Svg = input.surface !== 'terminal' && 'Svg' in input.table ? input.table.Svg : undefined
  const counts = taskCounts(run)
  const claimed = run.tasks.filter(task => task.state === 'claimed').slice(0, CLAIMED_ROWS)
  if (!run.tasks.length) {
    return (
      <Box key="sec-tasks">
        <Text dimColor>No tasks yet: the agents are planning.</Text>
      </Box>
    )
  }
  return (
    <Box key="sec-tasks" flexDirection="column">
      {Svg ? (
        <Svg source={taskBarSvg(counts)} alt={`Tasks: ${counts.done} done, ${counts.doing} in progress, ${counts.open} open`} width={BAR_WIDTH} height={BAR_HEIGHT} />
      ) : (
        <Box flexDirection="row">
          <Text color={STATUS.good}>{'█'.repeat(scaled(counts.done, counts))}</Text>
          <Text color={agentColor(0).light}>{'█'.repeat(scaled(counts.doing, counts))}</Text>
          <Text dimColor>{'░'.repeat(scaled(counts.open, counts))}</Text>
        </Box>
      )}
      <Box flexDirection="row" gap={2} flexWrap="wrap">
        <Text color={STATUS.good}>■ {counts.done} done</Text>
        <Text color={agentColor(0).light}>■ {counts.doing} doing</Text>
        <Text dimColor>■ {counts.open} open</Text>
      </Box>
      {claimed.map(task => (
        <Text key={`task-${task.id}`} dimColor wrap="truncate-end">
          #{task.id} {task.owner} · {task.title}
        </Text>
      ))}
    </Box>
  )
}

function checksSection(input: PaneInput, run: Run) {
  const { Box, Text } = input.table
  const latest = latestChecks(run).slice(-CHECK_CHIPS)
  if (!latest.length) return undefined
  return (
    <Box key="sec-checks" flexDirection="row" gap={2} flexWrap="wrap">
      {latest.map(check => (
        <Box key={`check-${check.id}`} flexDirection="row" gap={1}>
          <Text color={check.passed ? 'success' : 'error'} bold>
            {check.passed ? '✓' : '✗'} {cut(check.text, 28)}
          </Text>
          <Text dimColor>{(check.commit ?? '').slice(0, 7)}</Text>
        </Box>
      ))}
    </Box>
  )
}

function resultSection(input: PaneInput, run: Run, result: ResultFacts | undefined) {
  const { Box, Text, Button, Code } = input.table
  const { io, view, setView } = input
  const final = run.final
  if (!final) return undefined
  const verdict = verdictOf(run, final.commit)
  return (
    <Box key="sec-result" flexDirection="column" gap={1} borderStyle="round" borderColor="suggestion" paddingX={1}>
      <Box flexDirection="row" gap={2} flexWrap="wrap" alignItems="center">
        <Text bold>★ {final.commit.slice(0, 7)}</Text>
        {result ? <Text>{result.fileCount} files</Text> : <Text dimColor>reading the change</Text>}
        {result && <Text color="success">+{result.added}</Text>}
        {result && <Text color="error">−{result.removed}</Text>}
        <Text color={verdict.tone}>
          {verdict.icon} {verdict.word}
        </Text>
      </Box>
      <Text dimColor wrap="wrap">
        {final.by}: {cutWords(final.summary, SUMMARY_WORDS)}
      </Text>
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {run.state === 'ready' && (
          <Button key="deliver" variant="primary" hotkey="d" onPress={() => void act(io, () => deliver(io))}>
            ✓ Deliver into your branch
          </Button>
        )}
        {result && result.files.length > 0 && (
          <Button key="diff" hotkey="v" onPress={() => void setView(current => ({ ...current, showDiff: !current.showDiff }))}>
            {view.showDiff ? 'Hide diff' : 'Show diff'}
          </Button>
        )}
      </Box>
      {view.showDiff &&
        result?.files.map((file, index) => (
          <Box key={`file-${index}`} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text bold>{file.path}</Text>
              <Text color="success">+{file.added}</Text>
              <Text color="error">−{file.removed}</Text>
            </Box>
            {file.patch ? <Code source={file.patch} format="diff" path={file.path} /> : <Text dimColor>No text diff to show.</Text>}
          </Box>
        ))}
      {view.showDiff && result && result.fileCount > result.files.length && <Text dimColor>{result.fileCount - result.files.length} more files.</Text>}
    </Box>
  )
}

function steerSection(input: PaneInput, run: Run) {
  const { Box, Text, Button } = input.table
  const Input = input.surface !== 'mobile' && 'Input' in input.table ? input.table.Input : undefined
  const { io } = input
  return (
    <Box key="sec-steer" flexDirection="column" gap={1}>
      {Input && (
        <Input
          key="steer"
          label={run.state === 'ready' ? 'Ask for changes' : 'Steer all agents'}
          placeholder="One instruction for every agent"
          submitLabel="Send"
          onSubmit={value => void act(io, () => steerRun(io, value.trim()))}
        />
      )}
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {STEER_PRESETS.map(preset => (
          <Button key={`preset-${preset.key}`} onPress={() => void act(io, () => steerRun(io, preset.text))}>
            {preset.label}
          </Button>
        ))}
      </Box>
      {!Input && <Text dimColor>To steer in words, send /meld-steer and the instruction.</Text>}
    </Box>
  )
}

function startSection(input: PaneInput) {
  const { Box, Text, Button } = input.table
  const Input = input.surface !== 'mobile' && 'Input' in input.table ? input.table.Input : undefined
  const Select = input.surface !== 'mobile' && 'Select' in input.table ? input.table.Select : undefined
  const { view, setView } = input
  return (
    <Box key="sec-start" flexDirection="column" gap={1}>
      <Text bold>meld</Text>
      <Text dimColor>Several agents, one task, one commit you can check.</Text>
      {Input && Select ? (
        <Box flexDirection="column" gap={1}>
          <Input
            key="task"
            label="Task"
            placeholder="What the agents make"
            value={view.task}
            submitLabel="Start"
            onInput={value => void setView(current => ({ ...current, task: value }))}
            onSubmit={value => void startFromForm(input, value)}
          />
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Select key="agents" label="Agents" value={String(view.agents)} options={AGENT_OPTIONS} onSelect={value => void setView(current => ({ ...current, agents: Number(value) }))} />
            <Select key="model" label="Model" value={view.model} options={MODEL_OPTIONS} onSelect={value => void setView(current => ({ ...current, model: value }))} />
            <Select key="vcs" label="Version control" value={view.vcs} options={VCS_OPTIONS} onSelect={value => void setView(current => ({ ...current, vcs: value as PaneView['vcs'] }))} />
          </Box>
          <Button key="start" variant="primary" onPress={() => void startFromForm(input, view.task)}>
            ▶ Start
          </Button>
        </Box>
      ) : (
        <Text dimColor>Send /meld and the task. Add --agents 3 for three agents.</Text>
      )}
    </Box>
  )
}

async function startFromForm(input: PaneInput, task: string): Promise<void> {
  const request = task.trim()
  if (!request) {
    input.io.toast('meld: write the task first.')
    return
  }
  const result = await input.start({ request, agents: agentsOf(input.view.agents, input.view.model), vcs: input.view.vcs })
  input.io.toast(`meld: ${result.text ?? ''}`)
  await input.setView(current => ({ ...current, task: '' }))
}

async function act(io: Io, action: () => Promise<string>): Promise<void> {
  io.toast(`meld: ${await action()}`)
}

function laneOf(facts: Facts | null, worker: Worker): LaneFacts {
  return facts?.lanes.find(lane => lane.id === worker.id) ?? { id: worker.id, commits: [], edits: false }
}

/** What a worker does now, in a few words: its first claimed task, and its last tool with the first word of a command. */
function activityOf(run: Run, worker: Worker): string {
  if (worker.state === 'stopped') return cut(worker.activity, ACTIVITY_CHARS)
  const claim = run.tasks.find(task => task.state === 'claimed' && task.owner === worker.id)
  const doing = worker.state === 'idle' ? 'idle' : shortActivity(worker.activity)
  return claim ? `#${claim.id} ${doing}` : doing
}

function shortActivity(activity: string): string {
  const command = /^Bash: (\S+)/.exec(activity)
  return cut(command ? `Bash ${command[1]}` : activity, ACTIVITY_CHARS)
}

/** The agent of every worker when all share one, for the header; undefined when the workers differ. */
function sharedSpec(run: Run): string | undefined {
  const specs = new Set(run.workers.map(worker => specLabel(worker.agent)))
  return specs.size === 1 ? [...specs][0] : undefined
}

function specLabel(agent: AgentSpec): string {
  if (agent.type === WORKER_TYPE) return agent.model ?? ''
  return agent.model ? `${agent.type} ${agent.model}` : agent.type
}

function taskCounts(run: Run): TaskCounts {
  return {
    done: run.tasks.filter(task => task.state === 'done').length,
    doing: run.tasks.filter(task => task.state === 'claimed').length,
    open: run.tasks.filter(task => task.state === 'open').length,
  }
}

function scaled(count: number, counts: TaskCounts): number {
  const total = counts.done + counts.doing + counts.open
  return total ? Math.round((24 * count) / total) : 0
}

function latestChecks(run: Run): Entry[] {
  const byCommand = new Map<string, Entry>()
  for (const entry of run.log) if (entry.kind === 'check') byCommand.set(entry.text, entry)
  return [...byCommand.values()].sort((one, two) => one.id - two.id)
}

function verdictOf(run: Run, commit: string): { icon: string; word: string; tone: string } {
  const checks = run.log.filter(entry => entry.kind === 'check' && entry.commit === commit)
  if (checks.some(entry => !entry.passed)) return { icon: '✗', word: 'a check failed on this commit', tone: 'error' }
  if (checks.length) return { icon: '✓', word: `${checks.length} ${checks.length === 1 ? 'check' : 'checks'} passed on this commit`, tone: 'success' }
  return { icon: '⚠', word: 'no check ran on this commit', tone: 'warning' }
}

function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${Math.round(seconds / 3600)}h`
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`
  return `${(tokens / 1_000_000).toFixed(1)}M`
}

function cut(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars - 1)}…` : text
}

function cutWords(text: string, words: number): string {
  const all = text.split(/\s+/).filter(Boolean)
  return all.length > words ? `${all.slice(0, words).join(' ')}…` : all.join(' ')
}
