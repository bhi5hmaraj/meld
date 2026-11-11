import type { ElementTable, RenderSurface } from 'claude-code'

import type { Activity, AgentSpec, ContextKind, Entry, Facts, LaneFacts, PaneView, ResultFacts, Run, RunState, Task, Worker, WorkerId, WorkerState } from '../types'
import { deliver, discard, LEADING_CD, stopAll, stopOne } from '../core/actions'
import { CONTEXT_CAP, currentContext, NOT_STARTED, SPLIT_CALLS } from '../core/board'
import { activityOf, sharedContextOf } from '../core/metrics'
import type { SharedContext } from '../core/metrics'
import { STEER_PRESETS } from '../core/contract'
import { agentColor, BAR_HEIGHT, BAR_WIDTH, barCells, LANE_HEIGHT, LANE_WIDTH, laneAlt, laneGlyphs, laneSvg, partsBarSvg, STATUS } from './drawing'
import { FLOW_CELLS, FLOW_HEIGHT, FLOW_LEGEND, FLOW_WIDTH, flowCells, flowSvg, partsIn, partWords } from './drawing'
import type { TimeSpan } from './drawing'
import { efficiencyOf, lanesOf, progressOf } from '../core/metrics'
import type { LanePart } from '../core/metrics'
import type { Io } from '../core/ports'
import { agentsOf, formatStart, isAcpSpec, MAX_AGENTS, MODELS, WORKER_TYPE } from '../core/options'
import { leavesOf, percentLabel, requestParts, requestPercent, topTasks } from '../core/progress'
import type { Parts } from '../core/progress'
import { childrenOf, claimable, waitsFor } from '../core/tasks'

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
const KIND_SHAPE: Record<ContextKind, string> = { fact: '■', fail: '✕', interface: '◇' }
const KIND_TONE: Record<ContextKind, string | undefined> = { fact: undefined, fail: 'error', interface: 'suggestion' }
const KIND_ORDER: readonly ContextKind[] = ['fact', 'fail', 'interface']
const CONTEXT_ROWS = 5
const CONTEXT_WORDS = 8
const NAMED_WORKERS = 3
const STUCK_MS = 300_000
/** After this long with no text, the Now line of a card gives plain words from the tool calls of its agent. */
const SAID_FRESH_MS = 60_000
const DID_WORDS = 16
/** A card warns past these shares of CONTEXT_CAP and of the SPLIT_CALLS of its task. */
const NEAR_CAP = 0.8
const NEAR_SPLIT = 0.8
const TICK = '✓'
/** meld's own plain words for an agent that starts or goes on. */
const MELD_ACTIVITIES = new Set(['started', 'started again', 'goes on', 'starting'])
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const READ_COMMANDS = new Set(['cat', 'rg', 'grep', 'find', 'ls'])
const CLASS_WORDS: Partial<Record<Activity, string>> = {
  tests: 'running tests',
  builds: 'building',
  app: 'running the app',
  background: 'waiting for its background work',
  board: 'using the board',
}
const ACTIVITY_CHARS = 22
const CHECK_CHIPS = 6
const CARD_INDENT = 3
const SUMMARY_WORDS = 24
const REQUEST_BAR = { width: BAR_WIDTH, cells: 24 }
const ROW_INDENT = 2
const TITLE_WORDS = 8
/** The words of the rows: the progress block holds 100 words with its heading, the bar and percent of the request, and the count of the rows left out. */
const ROW_WORDS = 90
/** A ready task that waits longer than this while a worker is idle shows in the warning colour. */
const READY_WARN_MS = 300_000
const REQUEST_CHARS = 72
const FLOW_WINDOW_MS = 30 * 60_000
const FLOW_WINDOW_WORDS = 'last 30m'
const SKIPPED_ARGUMENT = /^(?:-|\d|\.$|[|&;<>]+$)/
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
  /** The dollars the session has spent, where the host keeps a cost ledger. */
  sessionCost?: number
  setView: (change: (view: PaneView) => PaneView) => Promise<unknown>
}

/** The ui.press and ui.input hooks of register.tsx take these presses: an agent that a closure starts would skip every meld hook. */
const SERVED_BY_HOOK = () => undefined

/** The meld pane: facts the person can check (commits, checks, the diff), and one press for each decision. No block holds more than 100 words. */
export function paneTree(input: PaneInput) {
  const { Box } = input.table
  const run = input.run
  if (!run) return <Box flexDirection="column">{startSection(input)}</Box>
  const facts = input.facts?.run === run.id ? input.facts : null
  return (
    <Box flexDirection="column" gap="lg">
      {headerSection(input, run)}
      {refusedSection(input, run)}
      {agentsSection(input, run, facts)}
      {progressSection(input, run)}
      {flowSection(input, run)}
      {contextSection(input, run)}
      {contextEntriesSection(input, run)}
      {checksSection(input, run)}
      {run.final && resultSection(input, run, facts?.result)}
      {LIVE.has(run.state) && steerSection(input, run)}
    </Box>
  )
}

function headerSection(input: PaneInput, run: Run) {
  const { Box, Text, Button } = input.table
  const { io } = input
  const calls = run.workers.reduce((sum, worker) => sum + (worker.calls ?? 0), 0)
  const spent = spentOf(input.sessionCost, run.costAtStart)
  const shared = sharedSpec(run)
  return (
    <Box key="sec-top" flexDirection="column" gap="xs">
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="md">
        <Box flexDirection="row" gap="sm" alignItems="center" flexWrap="wrap">
          <Text color={STATE_TONE[run.state]} bold>
            ● {STATE_WORD[run.state]}
          </Text>
          <Text dimColor>
            {run.vcs} · {run.workers.length} agents{shared ? ` · ${shared}` : ''} · {ago(input.now - run.startedAt)} · {spent ?? callsOf(calls)}
          </Text>
        </Box>
        <Box flexDirection="row" gap="sm">
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
      </Box>
      <Text dimColor wrap="truncate-end">
        {cut(run.request.split('\n')[0] ?? '', REQUEST_CHARS)}
      </Text>
    </Box>
  )
}

/** Why agents did not start, once per reason and in full: a lane has room for a few words. */
function refusedSection(input: PaneInput, run: Run) {
  const { Box, Text } = input.table
  const idsByReason = new Map<string, string[]>()
  for (const worker of run.workers.filter(isRefused)) {
    const reason = firstSentence(worker.activity.slice(NOT_STARTED.length))
    idsByReason.set(reason, [...(idsByReason.get(reason) ?? []), worker.id])
  }
  if (!idsByReason.size) return null
  return (
    <Box key="sec-refused" flexDirection="column" gap="xs">
      {[...idsByReason].map(([reason, ids]) => (
        <Text key={`refused-${ids[0]}`} color="error" wrap="wrap">
          {`${ids.join(', ')} did not start. ${reason}`}
        </Text>
      ))}
    </Box>
  )
}

function isRefused(worker: Worker): boolean {
  return worker.state === 'stopped' && worker.activity.startsWith(NOT_STARTED)
}

/** An engine refusal's first sentence: what went wrong. The sentences after it instruct the model. */
function firstSentence(text: string): string {
  return /^.*?\.(?=\s|$)/s.exec(text)?.[0] ?? text
}

function agentsSection(input: PaneInput, run: Run, facts: Facts | null) {
  const { Box } = input.table
  const checks = run.log.filter(entry => entry.kind === 'check')
  return (
    <Box key="agents" flexDirection="column" gap="md">
      {run.workers.map((worker, index) => agentCard(input, run, worker, index, laneOf(facts, worker), checks))}
    </Box>
  )
}

/**
 * The card of an agent, a block of its own (section 3.2 of docs/design/pane-metrics-logs.md): its task and its lane, what it
 * says or does now, what it finished and shared, its context and cost, and one warning.
 */
function agentCard(input: PaneInput, run: Run, worker: Worker, index: number, lane: LaneFacts, checks: Entry[]) {
  const { Box, Text, Button } = input.table
  const Svg = input.surface !== 'terminal' && 'Svg' in input.table ? input.table.Svg : undefined
  const { io, now } = input
  const marks = { lane, color: index, checks, final: run.final?.commit }
  const spec = sharedSpec(run) === undefined ? specLabel(worker.agent) : ''
  const claim = claimOf(run, worker)
  const [did, ...older] = doneBy(run, worker)
  const learned = currentContext(run, run.context?.length).find(entry => entry.by === worker.id)
  const said = nowLine(worker, now)
  const warning = warningOf(run, worker, now)
  return (
    <Box key={`sec-card-${worker.id}`} flexDirection="column" gap="xs">
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="md">
        <Box flexDirection="row" gap="sm" alignItems="center">
          <Text color={WORKER_TONE[worker.state]}>●</Text>
          <Text bold color={agentColor(index).light}>
            {worker.id}
          </Text>
          {spec && <Text dimColor>{spec}</Text>}
          <Text wrap="truncate-end">{taskLabel(run, worker, claim)}</Text>
          {claim?.claimedAt !== undefined && <Text dimColor>{ago(now - claim.claimedAt)}</Text>}
          {isRefused(worker) ? null : Svg ? (
            <Svg source={laneSvg(marks)} alt={laneAlt(worker.id, lane)} width={LANE_WIDTH} height={LANE_HEIGHT} isInteractive />
          ) : (
            <Text color={agentColor(index).light}>{laneGlyphs(marks)}</Text>
          )}
        </Box>
        {LIVE.has(run.state) && worker.state !== 'stopped' && (
          <Button key={`stop-${worker.id}`} dimColor onPress={() => void act(io, () => stopOne(io, worker.id))}>
            ■ Stop
          </Button>
        )}
      </Box>
      {!isRefused(worker) && (
        <Box flexDirection="column" gap="xs" paddingLeft={CARD_INDENT}>
          {said && <Text wrap="wrap">{said}</Text>}
          {did && (
            <Box flexDirection="row" gap="sm">
              <Text color="success">{TICK}</Text>
              <Text>{`#${did.id} ${cutWords(did.title, TITLE_WORDS)}`}</Text>
              <Text dimColor wrap="truncate-end">
                {cutWords(did.summary ?? '', DID_WORDS)}
              </Text>
              <Text dimColor>{(did.commit ?? '').slice(0, 7)}</Text>
            </Box>
          )}
          {older.length > 0 && <Text dimColor>{`and ${older.length} more`}</Text>}
          {learned && (
            <Box flexDirection="row" gap="sm">
              <Text color={KIND_TONE[learned.kind]}>{KIND_SHAPE[learned.kind]}</Text>
              <Text dimColor wrap="truncate-end">
                {cutWords(learned.text, CONTEXT_WORDS)}
              </Text>
            </Box>
          )}
          <Text dimColor>{costLine(worker)}</Text>
          {warning && <Text color="warning">{warning}</Text>}
        </Box>
      )}
    </Box>
  )
}

function claimOf(run: Run, worker: Worker): Task | undefined {
  return run.tasks.find(task => task.state === 'claimed' && task.owner === worker.id)
}

/** What the worker works on: its claimed task, the integration, or its state. */
function taskLabel(run: Run, worker: Worker, claim: Task | undefined): string {
  if (isRefused(worker)) return 'not started'
  if (worker.state === 'stopped') return 'stopped'
  if (claim) return `#${claim.id} ${cutWords(claim.title, TITLE_WORDS)}`
  if (worker.state === 'idle') return 'idle'
  return run.integrator === worker.id ? 'integrating' : 'no task'
}

/** The finished leaves of the worker, newest first. One shows on its card: two would pass the 100 words of the block. */
function doneBy(run: Run, worker: Worker): Task[] {
  return run.tasks.filter(task => task.state === 'done' && task.owner === worker.id && task.commit).sort((one, two) => (two.doneAt ?? 0) - (one.doneAt ?? 0) || two.id - one.id)
}

/** The last sentence of the agent; for a working agent that wrote no text for SAID_FRESH_MS, plain words from its last tool call. */
function nowLine(worker: Worker, now: number): string | undefined {
  const fresh = worker.said !== undefined && now - (worker.saidAt ?? 0) <= SAID_FRESH_MS
  return worker.state === 'working' && !fresh ? plainWords(worker.activity) : worker.said
}

/** What a worker does, in plain words from the kind of its last tool call: a card shows no raw command. */
function plainWords(activity: string): string {
  if (MELD_ACTIVITIES.has(activity)) return activity
  const command = /^Bash: (.*)$/.exec(activity)?.[1]
  if (command !== undefined) {
    const name = command.replace(LEADING_CD, '').split(/\s+/)[0] ?? ''
    return READ_COMMANDS.has(name) ? 'reading code' : (CLASS_WORDS[activityOf('Bash', command)] ?? 'running a command')
  }
  const [tool = '', target] = activity.split(' ')
  if (READ_TOOLS.has(tool)) return 'reading code'
  if (EDIT_TOOLS.has(tool)) return target ? `editing ${target.split('/').pop()}` : 'editing'
  return CLASS_WORDS[activityOf(tool, activity)] ?? `in a step of the agent: ${activity}`
}

/** The context of the agent against CONTEXT_CAP, and the cost of the worker in input tokens (costTokens). An ACP agent that reports no usage has no cost. */
function costLine(worker: Worker): string {
  const cost = worker.tokens || !isAcpSpec(worker.agent) ? `cost ${tokenCount(worker.tokens)} tokens` : 'cost not reported'
  return worker.context ? `context ${tokenCount(worker.context.used)} of ${tokenCount(CONTEXT_CAP)} cap, ${cost}` : cost
}

function tokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  return count >= 1000 ? `${Math.round(count / 1000)}k` : String(count)
}

/** The one warning of a card, the most urgent first. A stuck agent shows its last command as a clue. */
function warningOf(run: Run, worker: Worker, now: number): string | undefined {
  if (!LIVE.has(run.state) || worker.state === 'stopped') return undefined
  const claim = claimOf(run, worker)
  const quiet = now - Math.max(worker.activityAt, worker.saidAt ?? 0)
  if (worker.state === 'working' && quiet > STUCK_MS) return `No word for ${ago(quiet)}, last: ${shortActivity(worker.activity)}`
  if (claim && worker.state === 'working' && plainWords(worker.activity) === CLASS_WORDS.background) return 'Waits for its own background work'
  if (worker.state === 'idle' && claimable(run.tasks).length) return 'Idle, task ready'
  if ((worker.context?.used ?? 0) >= NEAR_CAP * CONTEXT_CAP) return 'Context near the cap: a fresh agent takes its next task'
  if (claim && (claim.calls ?? 0) >= NEAR_SPLIT * SPLIT_CALLS[claim.size ?? 'M']) return 'Long task, may split'
  return undefined
}

/** The state of a row: a leaf by its own state, a parent by the leaves under it. Each level of the tree shows the groups in this order. */
type RowGroup = 'claimed' | 'ready' | 'waiting' | 'done'
const GROUP_ORDER: Record<RowGroup, number> = { claimed: 0, ready: 1, waiting: 2, done: 3 }
/** The state of a leaf in words, or "N of M done" for a parent. */
type Word = { text: string; color?: string }
/** One row of the progress. isOpen: the rows of its children show under it. */
type Row = { task: Task; depth: number; isParent: boolean; isOpen: boolean; group: RowGroup; word: Word }
/** What each row of the tree reads: the run, its ready leaves, the choices of the person, and whether a worker is idle. */
type Tree = { run: Run; ready: ReadonlySet<number>; view: PaneView; now: number; idle: boolean }

/** The percent of the request, and one row for each top-level task, with the rows of its children when it is open. The rows stop before the block passes 100 words. */
function progressSection(input: PaneInput, run: Run) {
  const { Box, Text } = input.table
  if (!run.tasks.length) {
    return (
      <Box key="sec-progress">
        <Text dimColor>{LIVE.has(run.state) ? 'No tasks yet: the agents are planning.' : 'No tasks: the run ended before the agents planned.'}</Text>
      </Box>
    )
  }
  const tree: Tree = { run, ready: new Set(claimable(run.tasks).map(task => task.id)), view: input.view, now: input.now, idle: run.workers.some(worker => worker.state === 'idle') }
  const all = rowsOf(tree, topTasks(run.tasks), 0)
  const done = all.filter(row => row.depth === 0 && row.group === 'done' && !row.isOpen)
  const [first] = done
  const fold = first && done.length > 1 && done.length < all.length ? `${taskName(first.task)}, and ${done.length - 1} more done` : undefined
  const rows = fold ? all.filter(row => !done.includes(row)) : all
  const shown = rowsWithin(rows, ROW_WORDS - (fold ? wordCount(fold) : 0))
  const percent = percentLabel(requestPercent(run.tasks))
  return (
    <Box key="sec-progress" flexDirection="column" gap="sm">
      <Box key="progress-all" flexDirection="row" justifyContent="space-between" alignItems="center" gap="md">
        <Text bold>Plan</Text>
        <Box flexDirection="row" gap="sm" alignItems="center">
          <Text bold tabular>
            {percent}
          </Text>
          {partsBar(input, 'all', requestParts(run.tasks), REQUEST_BAR, `The request: ${percent} done`)}
        </Box>
      </Box>
      <Box flexDirection="column" gap="xs">
        {shown.map(row => taskRow(input, row))}
        {fold && <Text dimColor>{fold}</Text>}
        {shown.length < rows.length && <Text dimColor>{`${rows.length - shown.length} more`}</Text>}
      </Box>
    </Box>
  )
}

/** The title on the left and the word on the right. A press on a parent opens or closes it. */
function taskRow(input: PaneInput, row: Row) {
  const { Box, Text, Button } = input.table
  const { task, word } = row
  return (
    <Box key={`task-${task.id}`} flexDirection="row" justifyContent="space-between" alignItems="center" gap="md" paddingLeft={row.depth * ROW_INDENT}>
      {row.isParent ? (
        <Button key={`open-${task.id}`} plain onPress={() => void input.setView(view => chosen(view, task.id, row.isOpen))}>
          {rowLabel(row)}
        </Button>
      ) : (
        <Text wrap="truncate-end">{rowLabel(row)}</Text>
      )}
      <Text color={word.color} dimColor={!word.color}>
        {word.text}
      </Text>
    </Box>
  )
}

/** The done, claimed and open parts as a picture on a graphic surface. The terminal draws them as cells of three shapes, so each part reads with no colour. */
function partsBar(input: PaneInput, id: string, parts: Parts, size: { width: number; cells: number }, alt: string) {
  const { Box, Text } = input.table
  const Svg = input.surface !== 'terminal' && 'Svg' in input.table ? input.table.Svg : undefined
  if (Svg) return <Svg source={partsBarSvg(parts, size.width)} alt={alt} width={size.width} height={BAR_HEIGHT} />
  const cells = barCells(parts, size.cells)
  return (
    <Box key={`bar-${id}`} flexDirection="row">
      {cells.done > 0 && <Text color={STATUS.good}>{'█'.repeat(cells.done)}</Text>}
      {cells.claimed > 0 && <Text color={agentColor(0).light}>{'▓'.repeat(cells.claimed)}</Text>}
      {cells.open > 0 && <Text dimColor>{'░'.repeat(cells.open)}</Text>}
    </Box>
  )
}

/** The rows in tree order, each level in the order of GROUP_ORDER: the rows of the children of an open task follow its row. */
function rowsOf(tree: Tree, list: readonly Task[], depth: number): Row[] {
  const rows = list.map(task => rowOf(tree, task, depth)).sort((one, two) => GROUP_ORDER[one.group] - GROUP_ORDER[two.group])
  return rows.flatMap(row => (row.isOpen ? [row, ...rowsOf(tree, childrenOf(tree.run.tasks, row.task.id), depth + 1)] : [row]))
}

/** A parent opens itself while a task under it is claimed or ready, and closes itself when they are all done; the choice of the person wins. */
function rowOf(tree: Tree, task: Task, depth: number): Row {
  const { run, view } = tree
  const isParent = childrenOf(run.tasks, task.id).length > 0
  const leaves = leavesOf(run.tasks, task)
  const group = groupOf(tree, leaves)
  const opens = view.open?.includes(task.id) || (!view.closed?.includes(task.id) && (group === 'claimed' || group === 'ready'))
  if (!isParent) return { task, depth, isParent, isOpen: false, group, word: leafWord(tree, task) }
  const done = leaves.filter(leaf => leaf.state === 'done').length
  return { task, depth, isParent, isOpen: opens, group, word: { text: `${done} of ${leaves.length} done` } }
}

function groupOf(tree: Tree, leaves: readonly Task[]): RowGroup {
  if (leaves.some(leaf => leaf.state === 'claimed')) return 'claimed'
  if (leaves.some(leaf => tree.ready.has(leaf.id))) return 'ready'
  return leaves.every(leaf => leaf.state === 'done') ? 'done' : 'waiting'
}

/** A leaf in words: its worker working, ready and for how long, the task it waits for, or done. The card of the worker gives its time on the task. */
function leafWord(tree: Tree, task: Task): Word {
  const { run, now } = tree
  if (task.state === 'claimed') return { text: `${task.owner} working`, color: agentColor(run.workers.findIndex(worker => worker.id === task.owner)).light }
  if (task.state === 'done') return { text: `${TICK} done`, color: 'success' }
  if (tree.ready.has(task.id)) {
    if (task.readyAt === undefined) return { text: 'ready' }
    const waited = now - task.readyAt
    return { text: `ready ${ago(waited)}`, color: waited > READY_WARN_MS && tree.idle ? 'warning' : undefined }
  }
  const need = waitsFor(run.tasks, task)
  return { text: need === undefined ? 'waiting' : waitText(need), color: 'warning' }
}

/** The first rows whose words add up to `limit` at most. */
function rowsWithin(rows: readonly Row[], limit: number): Row[] {
  const shown: Row[] = []
  let words = 0
  for (const row of rows) {
    words += rowWords(row)
    if (words > limit) break
    shown.push(row)
  }
  return shown
}

/** The words of a row as the limit of a block counts them. */
function rowWords(row: Row): number {
  return wordCount(rowLabel(row)) + wordCount(row.word.text)
}

function rowLabel(row: Row): string {
  const mark = row.isParent ? (row.isOpen ? '▾' : '▸') : '·'
  return `${mark} ${taskName(row.task)}`
}

function taskName(task: Task): string {
  return `#${task.id} ${cutWords(task.title, TITLE_WORDS)}`
}

function waitText(id: number): string {
  return `waits for #${id}`
}

/** The view after the person opens or closes a parent: the choice stays in view.open or view.closed until the run ends. */
function chosen(view: PaneView, id: number, isOpen: boolean): PaneView {
  const open = (view.open ?? []).filter(one => one !== id)
  const closed = (view.closed ?? []).filter(one => one !== id)
  return isOpen ? { ...view, open, closed: [...closed, id] } : { ...view, open: [...open, id], closed }
}

/**
 * One lane for each worker over the whole run, or the last 30 minutes of a longer one, and four metrics of section 4 of
 * docs/design/pane-metrics-logs.md. A graphic surface draws each lane as a picture with its parts in words; the terminal
 * draws it as a row of cells.
 */
function flowSection(input: PaneInput, run: Run) {
  const { Box, Text } = input.table
  const Svg = input.surface !== 'terminal' && 'Svg' in input.table ? input.table.Svg : undefined
  const end = run.endedAt ?? input.now
  const window = { from: Math.max(run.startedAt, end - FLOW_WINDOW_MS), to: end }
  const lanes = lanesOf(run, input.now).filter(lane => lane.to > lane.from && lane.to > window.from)
  if (!lanes.length) return undefined
  const sleeps: TimeSpan[] = run.log.filter(entry => entry.kind === 'host').map(entry => ({ from: entry.from ?? entry.at, to: entry.at }))
  return (
    <Box key="sec-flow" flexDirection="column" gap="xs">
      <Box flexDirection="row" gap="sm">
        <Text bold>Flow</Text>
        <Text dimColor>{end - run.startedAt > FLOW_WINDOW_MS ? FLOW_WINDOW_WORDS : 'whole run'}</Text>
      </Box>
      {lanes.map(lane => {
        const color = run.workers.findIndex(worker => worker.id === lane.worker)
        const parts = partsIn(lane.parts, window)
        return (
          <Box key={`flow-${lane.worker}`} flexDirection="row" gap="sm" alignItems="center">
            {Svg && <Text>{lane.worker}</Text>}
            {Svg ? (
              <Svg source={flowSvg(parts, sleeps, window, color)} alt={laneWords(lane.worker, parts)} width={FLOW_WIDTH} height={FLOW_HEIGHT} />
            ) : (
              <Text color={agentColor(color).light}>{`${lane.worker} ${flowCells(parts, sleeps, window, FLOW_CELLS)}`}</Text>
            )}
          </Box>
        )
      })}
      {!Svg && <Text dimColor>{FLOW_LEGEND}</Text>}
      <Text dimColor wrap="wrap">
        {flowMetrics(run, input.now)}
      </Text>
    </Box>
  )
}

function laneWords(id: WorkerId, parts: readonly LanePart[]): string {
  return `${id}: ${parts.map(part => `${partWords(part)} ${ago(part.to - part.from)}`).join(', ')}`
}

/** Busy share, ready with no agent, task time and cost per finished task: the same words on every surface. */
function flowMetrics(run: Run, now: number): string {
  const { busyShare, costPerTask } = efficiencyOf(run, now)
  const { done, readyNoAgent, taskMs } = progressOf(run, now)
  const ready = `ready with no agent ${ago(readyNoAgent.ms)}${readyNoAgent.now ? `, ${readyNoAgent.now} now` : ''}`
  const finished = done ? [`task time ${ago(taskMs)}`, `${tokenCount(costPerTask)} tokens per finished task`] : ['no finished task yet']
  return [`busy ${Math.round(busyShare * 100)}%`, ready, ...finished].join('; ')
}

function tokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(Math.round(tokens))
}

/** The heading and the metrics of the shared context: whether the agents learn from each other. */
function contextSection(input: PaneInput, run: Run) {
  const { Box, Text } = input.table
  if (!currentContext(run, 1).length) return undefined
  return (
    <Box key="sec-context" flexDirection="column" gap="xs">
      <Text bold>Shared context</Text>
      <Box key="context-metrics" flexDirection="row" gap="sm" flexWrap="wrap">
        {contextMetrics(sharedContextOf(run, input.now)).map(metric => (
          <Text key={metric} dimColor>
            {metric}
          </Text>
        ))}
      </Box>
    </Box>
  )
}

/** The newest current entries, by kind: who shared each one, who got it and who used it. A block of its own, as five lines fill most of 100 words. */
function contextEntriesSection(input: PaneInput, run: Run) {
  const { Box, Text } = input.table
  const entries = currentContext(run, CONTEXT_ROWS).sort((one, other) => KIND_ORDER.indexOf(one.kind) - KIND_ORDER.indexOf(other.kind))
  if (!entries.length) return undefined
  return (
    <Box key="sec-context-entries" flexDirection="column" gap="xs">
      {entries.map(entry => {
        const users = usersOf(run, entry.id)
        return (
          <Box key={`context-${entry.id}`} flexDirection="row" gap="sm">
            <Text color={KIND_TONE[entry.kind]}>{KIND_SHAPE[entry.kind]}</Text>
            <Text color={agentColor(run.workers.findIndex(worker => worker.id === entry.by)).light}>{entry.by}</Text>
            <Text dimColor wrap="truncate-end">
              {cutWords(entry.text, CONTEXT_WORDS)}
            </Text>
            <Text dimColor>{`got ${workersText(entry.seenBy)}`}</Text>
            {users.length > 0 && <Text>{`used by ${workersText(users)}`}</Text>}
          </Box>
        )
      })}
    </Box>
  )
}

/** The workers whose finished tasks name the entry in used. */
function usersOf(run: Run, id: number): WorkerId[] {
  return [...new Set(run.tasks.flatMap(task => (task.state === 'done' && task.owner && task.used?.includes(id) ? [task.owner] : [])))]
}

/** A few workers by name; more as a count, so that a line stays short with eight agents. */
function workersText(workers: readonly WorkerId[]): string {
  if (!workers.length) return 'none'
  return workers.length > NAMED_WORKERS ? `${workers.length} agents` : workers.join(' ')
}

/** The metrics of section 4.4 of the pane note, one short text each. */
function contextMetrics(shared: SharedContext): string[] {
  const { entries, all, delivered, deliveryMs, cited, received, failsHeeded, failsReceived, repeatedFails, perTask } = shared
  return [
    `${counted(all, 'entry', 'entries')}: ${counted(entries.fact, 'fact')}, ${counted(entries.fail, 'fail')}, ${counted(entries.interface, 'interface')}`,
    ...(perTask ? [`${Number(perTask.toFixed(1))} for each done task`] : []),
    `${delivered} of ${all} delivered${delivered ? `, median ${ago(deliveryMs)}` : ''}`,
    `${cited} of ${counted(received, 'received entry', 'received entries')} cited`,
    `${failsHeeded} of ${counted(failsReceived, 'fail')} heeded`,
    `${counted(repeatedFails, 'fail')} repeated`,
  ]
}

function counted(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

function checksSection(input: PaneInput, run: Run) {
  const { Box, Text } = input.table
  const latest = latestChecks(run).slice(-CHECK_CHIPS)
  if (!latest.length) return undefined
  return (
    <Box key="sec-checks" flexDirection="row" gap="lg" flexWrap="wrap">
      {latest.map(check => (
        <Box key={`check-${check.id}`} flexDirection="row" gap="sm">
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
    <Box key="sec-result" flexDirection="column" gap="md" borderStyle="round" borderColor="suggestion" paddingX="md" paddingY="sm">
      <Box flexDirection="row" gap="md" flexWrap="wrap" alignItems="center">
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
      <Box flexDirection="row" gap="sm" flexWrap="wrap">
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
    <Box key="sec-steer" flexDirection="column" gap="md">
      {Input && (
        <Input
          key="steer"
          label={run.state === 'ready' ? 'Ask for changes' : 'Steer all agents'}
          placeholder="One instruction for every agent"
          submitLabel="Send"
          onSubmit={SERVED_BY_HOOK}
        />
      )}
      <Box flexDirection="row" gap="sm" flexWrap="wrap">
        {STEER_PRESETS.map(preset => (
          <Button key={`preset-${preset.key}`} onPress={SERVED_BY_HOOK}>
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
    <Box key="sec-start" flexDirection="column" gap="md">
      <Text bold>meld</Text>
      <Text dimColor>Several agents, one request, one commit you can check.</Text>
      {Input && Select ? (
        <Box flexDirection="column" gap={1}>
          <Input
            key="task"
            label="Request"
            placeholder="What the agents make"
            value={view.task}
            submitLabel="Start"
            onInput={value => void setView(current => ({ ...current, task: value }))}
            onSubmit={SERVED_BY_HOOK}
          />
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Select key="agents" label="Agents" value={String(view.agents)} options={AGENT_OPTIONS} onSelect={value => void setView(current => ({ ...current, agents: Number(value) }))} />
            <Select key="model" label="Model" value={view.model} options={MODEL_OPTIONS} onSelect={value => void setView(current => ({ ...current, model: value }))} />
            <Select key="vcs" label="Version control" value={view.vcs} options={VCS_OPTIONS} onSelect={value => void setView(current => ({ ...current, vcs: value as PaneView['vcs'] }))} />
          </Box>
          <Button key="start" variant="primary" onPress={SERVED_BY_HOOK}>
            ▶ Start
          </Button>
        </Box>
      ) : (
        <Text dimColor>Send /meld and the request. Add --agents 3 for three agents.</Text>
      )}
    </Box>
  )
}

async function act(io: Io, action: () => Promise<string>): Promise<void> {
  io.toast(`meld: ${await action()}`)
}

function laneOf(facts: Facts | null, worker: Worker): LaneFacts {
  return facts?.lanes.find(lane => lane.id === worker.id) ?? { id: worker.id, commits: [], edits: false }
}

/** A shell command as its name and its target (past a leading cd, flags, numbers and redirections), a path as its last part; another tool as its name and target. */
function shortActivity(activity: string): string {
  const command = /^Bash: (.*)$/.exec(activity)?.[1]
  if (command === undefined) return cut(activity, ACTIVITY_CHARS)
  const [name = 'Bash', ...rest] = command.replace(LEADING_CD, '').split(/\s+/).filter(Boolean)
  const target = rest.find(word => !SKIPPED_ARGUMENT.test(word))
  return cut(target ? `${name} ${target.split('/').filter(Boolean).pop() ?? target}` : name, ACTIVITY_CHARS)
}

function callsOf(calls: number): string {
  return `${calls} ${calls === 1 ? 'call' : 'calls'}`
}

/** The dollars the session spent since the run started, when the host keeps a cost ledger and the run noted its start. */
function spentOf(sessionCost: number | undefined, costAtStart: number | undefined): string | undefined {
  if (sessionCost === undefined || costAtStart === undefined) return undefined
  return `$${Math.max(0, sessionCost - costAtStart).toFixed(2)}`
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

function cut(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars - 1)}…` : text
}

function cutWords(text: string, words: number): string {
  const all = text.split(/\s+/).filter(Boolean)
  return all.length > words ? `${all.slice(0, words).join(' ')}…` : all.join(' ')
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}
