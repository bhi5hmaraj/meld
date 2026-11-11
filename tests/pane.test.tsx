import { expect, test } from 'claude-code/testing'

import { addCheck, addTasks, bindWorker, boardFor, claimTask, declareFinal, finishTask, isFailure, refuseWorker, setActivity, shareEntry, splitTask, startRun, takeIntegration } from '../core/board'
import { agentColor } from '../hooks/drawing'
import type { Change, ContextKind, Facts, Run, Task, WorkerId } from '../types'
import { STORED_BY_0_6_0, STORED_BY_0_7_0 } from './stored-runs'

const NOW = 1_800_000_000_000
const FULL = 'f'.repeat(40)
const OTHER = 'e'.repeat(40)
const BASE = 'a'.repeat(40)
const PANE = {
  plugin: 'meld',
  component: 'Pane',
  requestId: 'meld',
  props: { title: 'meld', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const
const GRAPHIC_SURFACES = ['desktop', 'mobile', 'vscode'] as const
const ALL_SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const WORD_LIMIT = 100
const LONG_ACTIVITY = 'Bash: pnpm --filter api test -- --run apps/api/src/workbench/routes.test.ts --reporter verbose'
const LONG_SHARE = 'word '.repeat(100).trim()
const SHARES: { by: WorkerId; kind: ContextKind; text: string }[] = [
  { by: 'w1', kind: 'fact', text: 'The tokens live in src/theme.css as CSS variables.' },
  { by: 'w2', kind: 'fail', text: 'A global stylesheet breaks the old pages, as they set colours inline.' },
  { by: 'w3', kind: 'interface', text: 'toggleTheme(): void flips data-theme on the html element.' },
  { by: 'w1', kind: 'fact', text: 'The header has no room for a toggle on phones.' },
  { by: 'w2', kind: 'fact', text: 'The docs build reads docs/theme.md.' },
  { by: 'w3', kind: 'interface', text: 'useTheme() gives light or dark.' },
]
const CORRECTION = 'useTheme(): Theme gives the stored theme, light or dark.'
const CLOSED_VIEW = { showDiff: false, task: '', agents: 2, model: 'inherit', vcs: 'auto' }
const LONG_TITLE = 'Make the theme tokens, the toggle, the docs and the tests of the dark theme'

type Stored = { value: unknown; version: number }

/** The values of the plugin as the engine stores them: a write with a stale version is refused, as `$.state` does. */
class FakeState {
  values = new Map<string, Stored>()

  load(run: Run | null, facts: Facts | null, view?: object): FakeState {
    this.values.clear()
    if (run) this.values.set('run', { value: { shape: 'run-5', value: run }, version: 1 })
    if (facts) this.values.set('facts', { value: { shape: 'facts-1', value: facts }, version: 1 })
    if (view) this.values.set('view', { value: { shape: 'view-1', value: view }, version: 1 })
    return this
  }

  get(key: string): Stored {
    return this.values.get(key) ?? { value: undefined, version: 0 }
  }

  set(event: { key: string; value: unknown; ifVersion?: number }) {
    const current = this.get(event.key)
    if (event.ifVersion !== undefined && event.ifVersion !== current.version) return { isSet: false, version: current.version, value: current.value }
    const version = current.version + 1
    this.values.set(event.key, { value: event.value, version })
    return { isSet: true, version }
  }
}

function runOf<T>(change: Change<T>): Run {
  if (isFailure(change)) throw new Error(`${change.error}: ${change.message}`)
  return change.run
}

function workingRun(count: number): Run {
  const ids = Array.from({ length: count }, (_, index) => `w${index + 1}` as WorkerId)
  const workers = ids.map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: `meld/r1/${id}`, agent: { type: 'meld:worker', model: 'sonnet' } }))
  let run = startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: BASE, vcs: 'git', now: NOW, workers })
  for (const [index, id] of ids.entries()) run = setActivity(runOf(bindWorker(run, id, `agent-${index + 1}`, NOW)), id, LONG_ACTIVITY, NOW)
  const titles = ['Theme tokens in theme.css', 'Toggle in the header', 'Docs for the theme', 'Tests for the toggle', 'Contrast check', 'Dark images']
  run = runOf(addTasks(run, 'w1', { seen: 0, tasks: titles.slice(0, Math.min(6, count + 1)).map(title => ({ title })) }, NOW))
  run = runOf(claimTask(run, 'w1', 1, 1, NOW))
  for (const [index, command] of ['pnpm test', 'pnpm lint', 'pnpm build', 'node --test', 'tsc -p .', 'pnpm e2e'].entries()) {
    run = runOf(addCheck(run, ids[index % count] ?? 'w1', { command, commit: FULL, passed: index !== 1, output: '' }, NOW))
  }
  return run
}

function task(id: number, title: string, fields: Partial<Task> = {}): Task {
  return { id, title, detail: '', state: 'open', version: 1, ...fields }
}

/** #1 is an L parent of a done part and a part that w3 claims; w2 claims #2; #3 waits for #1. The request is at 33%. */
function treeRun(): Run {
  const tasks = [
    task(1, 'Theme tokens', { size: 'L' }),
    task(2, 'Toggle in the header', { state: 'claimed', owner: 'w2', version: 2 }),
    task(3, 'Docs for the theme', { size: 'S', needs: [1] }),
    task(4, 'Colour tokens', { parent: 1, state: 'done', owner: 'w1', version: 3, commit: FULL, summary: 'Colours' }),
    task(5, 'Spacing tokens', { parent: 1, state: 'claimed', owner: 'w3', version: 2 }),
  ]
  return { ...workingRun(3), tasks, taskList: 2 }
}

/** Eight workers on the eight parts of #1, and twelve tasks with long titles that wait for #1. */
function crowdedRun(): Run {
  const ids = Array.from({ length: 8 }, (_, index) => `w${index + 1}` as WorkerId)
  const parts = ids.map((id, index) => task(index + 2, LONG_TITLE, { parent: 1, state: 'claimed', owner: id, version: 2 }))
  const waiting = Array.from({ length: 12 }, (_, index) => task(index + 10, LONG_TITLE, { needs: [1] }))
  return { ...workingRun(8), tasks: [task(1, LONG_TITLE, { size: 'L' }), ...parts, ...waiting] }
}

/** Every string that a drawn element shows, in document order: the label of a Button, and the strings of the children. */
function textsOf(node: unknown): string[] {
  if (typeof node === 'string') return [node]
  const element = node as { props?: { label?: unknown }; children?: unknown[] } | undefined
  const label = element?.props?.label
  return [...(typeof label === 'string' ? [label] : []), ...(element?.children ?? []).flatMap(textsOf)]
}

function rowKeys(boxes: { key: string | undefined }[]): (string | undefined)[] {
  return boxes.filter(box => box.key?.startsWith('task-')).map(box => box.key)
}

/** w1 splits its claim #1 into #5, which it keeps, and #6, which is open. */
function splitRun(): Run {
  return runOf(splitTask(workingRun(3), 'w1', { task: 1, version: 2, seen: 1, tasks: [{ title: 'Colour tokens' }, { title: 'Spacing tokens', size: 'S' }] }, NOW))
}

/** w1 finishes #5, and w2 claims and finishes #6: #1 is done. */
function splitDoneRun(): Run {
  const first = runOf(finishTask(splitRun(), 'w1', 5, 1, FULL, 'Colours', NOW))
  return runOf(finishTask(runOf(claimTask(first, 'w2', 6, 1, NOW)), 'w2', 6, 2, OTHER, 'Spacing', NOW))
}

function readyRun(run = workingRun(3)): Run {
  return runOf(declareFinal(runOf(takeIntegration(run, 'w2', NOW)), 'w2', FULL, 'Adds a dark theme with a toggle, tokens and docs.', NOW))
}

/** Six shared entries and a seventh that corrects the sixth, read by w1 and w2. */
function sharedRun(run: Run, text?: string): Run {
  const shared = SHARES.reduce((current, share) => runOf(shareEntry(current, share.by, { kind: share.kind, text: text ?? share.text }, NOW)), run)
  const corrected = runOf(shareEntry(shared, 'w3', { kind: 'interface', text: text ?? CORRECTION, replaces: SHARES.length }, NOW))
  return boardFor(boardFor(corrected, 'w1', NOW).run, 'w2', NOW).run
}

/** The text of each part of a line: the children of each Text in it. */
function partsOf(node: unknown): string[] {
  const line = node as { children?: { children?: unknown[] }[] } | undefined
  return (line?.children ?? []).map(part => (part.children ?? []).join(''))
}

function factsOf(run: Run): Facts {
  const lanes = run.workers.map((worker, index) => ({
    id: worker.id,
    commits: [
      { commit: FULL, subject: 'Merge the work of w1', parents: 2, conflict: false },
      { commit: OTHER, subject: `Work of ${worker.id}`, parents: 1, conflict: index === 2 },
    ],
    edits: index === 0,
  }))
  const files = [
    { path: 'src/theme.css', added: 12, removed: 3, patch: '--- a/src/theme.css\n+++ b/src/theme.css\n@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d' },
    { path: 'logo.png', added: 0, removed: 0, patch: '' },
  ]
  return run.final ? { run: run.id, lanes, result: { commit: FULL, files, fileCount: 3, added: 16, removed: 3 } } : { run: run.id, lanes }
}

function wordsOf(node: unknown): number {
  if (typeof node === 'string') return node.split(/\s+/).filter(Boolean).length
  if (!node || typeof node !== 'object') return 0
  const element = node as { type?: string; props?: Record<string, unknown>; children?: unknown[] }
  if (element.type === 'Code') return 0
  const props = element.props ?? {}
  const own = ['label', 'placeholder'].reduce((sum, name) => sum + (typeof props[name] === 'string' ? wordsOf(props[name]) : 0), 0)
  return own + (element.children ?? []).reduce<number>((sum, child) => sum + wordsOf(child), 0)
}

test('the pane draws one lane per agent on every graphic surface, each with a stop button', async ($, on) => {
  const state = new FakeState().load(workingRun(3), factsOf(workingRun(3)))
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  for (const surface of GRAPHIC_SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.findAll({ type: 'Svg' })).filter(svg => /^w\d+: /.test(String(svg.props.alt)))).toHaveLength(3)
    expect(await ui.find({ key: 'stop-w3' })).toBeDefined()
    expect(await ui.find({ key: 'stop' })).toBeDefined()
    await ui.unmount()
  }
})

test('the terminal draws the lanes as glyphs', async ($, on) => {
  const state = new FakeState().load(workingRun(2), factsOf(workingRun(2)))
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  expect((await ui.find({ type: 'Text', text: /^·/ }))?.text).toBe('·●◆○')
  await ui.unmount()
})

test('a ready run shows its change and checks, with Deliver as the main action', async ($, on) => {
  const state = new FakeState().load(readyRun(), factsOf(readyRun()))
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  for (const surface of ALL_SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'deliver' }))?.props).toMatchObject({ variant: 'primary', hotkey: 'd' })
    expect(await ui.find({ type: 'Text', text: '3 files' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /a check failed on this commit/ })).toBeDefined()
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    await ui.unmount()
  }
})

test('Show diff opens the real diff of the result', async ($, on) => {
  const state = new FakeState().load(readyRun(), factsOf(readyRun()))
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  on('state.set', ($, e) => ({ value: state.set(e) }))
  const first = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await first.press({ key: 'diff' })
  await first.unmount()
  const second = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await second.find({ type: 'Code' }))?.props).toMatchObject({ format: 'diff', path: 'src/theme.css' })
  expect(await second.find({ type: 'Text', text: '1 more files.' })).toBeDefined()
  await second.unmount()
})

test('a preset button steers every live agent', async ($, on) => {
  const state = new FakeState().load(workingRun(3), null)
  const sent: string[] = []
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  on('state.set', ($, e) => ({ value: state.set(e) }))
  on('session.send', ($, e) => {
    sent.push(String(e.text))
    return { isDelivered: true as const }
  })
  on('ui.toast', () => ({ value: undefined }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'preset-tests' })
  expect(sent).toHaveLength(3)
  expect(sent[0]).toContain('Add tests for each change')
  await ui.unmount()
})

test('Enter in the steer field steers every live agent', async ($, on) => {
  const state = new FakeState().load(workingRun(3), null)
  const sent: string[] = []
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  on('state.set', ($, e) => ({ value: state.set(e) }))
  on('session.send', ($, e) => {
    sent.push(String(e.text))
    return { isDelivered: true as const }
  })
  on('ui.toast', () => ({ value: undefined }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'steer', text: 'Use the brand colours' })
  expect(sent).toHaveLength(3)
  expect(sent[0]).toContain('Use the brand colours')
  await ui.unmount()
})

test('Start with no task asks for the task', async ($, on) => {
  const state = new FakeState().load(null, null)
  const toasts: string[] = []
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  on('ui.toast', ($, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'start' })
  expect(toasts).toEqual(['meld: Write the task first.'])
  await ui.unmount()
})

test('with no run the desktop pane shows the start form', async ($, on) => {
  const state = new FakeState().load(null, null)
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  for (const key of ['task', 'agents', 'model', 'vcs', 'start']) expect(await ui.find({ key })).toBeDefined()
  await ui.unmount()
})

test('with no run the mobile pane tells how to start', async ($, on) => {
  const state = new FakeState().load(null, null)
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect((await ui.find({ type: 'Text', text: /^Send \/meld/ }))?.text).toBe('Send /meld and the request. Add --agents 3 for three agents.')
  await ui.unmount()
})

test('the start form calls what you type the request, as the README does', async ($, on) => {
  const state = new FakeState().load(null, null)
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'task' }))?.props.label).toBe('Request')
  expect(await ui.find({ type: 'Text', text: 'Several agents, one request, one commit you can check.' })).toBeDefined()
  await ui.unmount()
})

test('no block of the pane holds more than 100 words, with eight agents or a ready result, and long shared entries', async ($, on) => {
  const state = new FakeState()
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  for (const run of [sharedRun(workingRun(8), LONG_SHARE), readyRun(sharedRun(workingRun(3), LONG_SHARE))]) {
    state.load(run, factsOf(run), { showDiff: true, task: '', agents: 2, model: 'inherit', vcs: 'auto' })
    for (const surface of ALL_SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const blocks = (await ui.findAll({ type: 'Box' })).filter(box => box.key?.startsWith('sec-'))
      expect(blocks.length).toBeGreaterThan(3)
      for (const block of blocks) expect(wordsOf(block), `${block.key} on ${surface}`).toBeLessThanOrEqual(WORD_LIMIT)
      await ui.unmount()
    }
  }
})

test('an agent card counts its tool calls, not its tokens', async ($, on) => {
  const run = workingRun(2)
  const counted = { ...run, workers: run.workers.map((worker, index) => ({ ...worker, calls: 27, tokens: index === 1 ? 182_000 : 0 })) }
  const state = new FakeState().load(counted, factsOf(counted))
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.findAll({ type: 'Text', text: '27 calls' })).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: / tok$/ })).toBeUndefined()
  await ui.unmount()
})

test('the header shows the dollars the session spent since the run started', async ($, on) => {
  const state = new FakeState().load({ ...workingRun(2), costAtStart: 1.25 }, null)
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [], cost: { usd: 3.75 } } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: / · \$2\.50$/ })).toBeDefined()
  await ui.unmount()
})

test('the header says what the agents work on, in one line', async ($, on) => {
  const state = new FakeState().load(workingRun(2), null)
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  for (const surface of ALL_SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'Add a dark theme' })).toBeDefined()
    await ui.unmount()
  }
})

test('a lane shows a shell command as its name and its target, past flags and ranges', async ($, on) => {
  const run = workingRun(2)
  const busy = { ...run, workers: run.workers.map(worker => ({ ...worker, activity: 'Bash: cd /tmp/meld/r1/w2 && sed -n 80,189p hooks/contract.ts' })) }
  const state = new FakeState().load(busy, null)
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'sed contract.ts' })).toBeDefined()
  await ui.unmount()
})

test('each agent has a card: its lane and Stop on the first line, what it does on the second', async ($, on) => {
  const state = new FakeState().load(workingRun(2), factsOf(workingRun(2)))
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const [top, detail] = ((await ui.find({ key: 'lane-w1' }))?.children ?? []).map(child => JSON.stringify(child))
  expect(top).toContain('"Svg"')
  expect(top).toContain('stop-w1')
  expect(detail).toContain('#1 ')
  expect(detail).not.toContain('stop-w1')
  await ui.unmount()
})

const REFUSAL = 'The server-side auto mode classifier gave no verdict for Agent: the request that produced this action did not ask for one. Issue the action again once, as-is.'

function refusedRun(): Run {
  const ids = ['w1', 'w2', 'w3'] as WorkerId[]
  const workers = ids.map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: `${id}@`, agent: { type: 'meld:worker' } }))
  const run = startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: BASE, vcs: 'jj', now: NOW, workers })
  return ids.reduce((current, id) => refuseWorker(current, id, REFUSAL, NOW), run)
}

test('agents that did not start show the first sentence of the refusal once', async ($, on) => {
  const state = new FakeState().load(refusedRun(), null)
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const said = 'w1, w2, w3 did not start. The server-side auto mode classifier gave no verdict for Agent: the request that produced this action did not ask for one.'
  expect(await ui.findAll({ type: 'Text', text: said })).toHaveLength(1)
  await ui.unmount()
})

test('the lane of an agent that did not start says only that', async ($, on) => {
  const state = new FakeState().load(refusedRun(), null)
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.findAll({ type: 'Text', text: 'not started' })).toHaveLength(3)
  await ui.unmount()
})

test('a run that ended with no tasks says so, with no agents planning', async ($, on) => {
  const state = new FakeState().load(refusedRun(), null)
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'No tasks: the run ended before the agents planned.' })).toBeDefined()
  await ui.unmount()
})

/** sharedRun, where w1 finishes #1 and names entry 7 in used. */
function citedRun(): Run {
  return runOf(finishTask(sharedRun(workingRun(3)), 'w1', 1, 2, FULL, 'Tokens', NOW, {}, { used: [7] }))
}

test('the shared context shows the five newest current entries by kind, facts, fails, then interfaces, newest first in each kind', async ($, on) => {
  const state = new FakeState().load(sharedRun(workingRun(3)), null)
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const lines = (await ui.findAll({ type: 'Box' })).filter(box => /^context-\d+$/.test(box.key ?? ''))
  expect(lines.map(line => line.key)).toEqual(['context-5', 'context-4', 'context-2', 'context-7', 'context-3'])
  await ui.unmount()
})

test('a line of the shared context shows the shape of the kind, who shared it, the text, who got it and who used it', async ($, on) => {
  const state = new FakeState().load(citedRun(), null)
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  for (const surface of ALL_SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(partsOf(await ui.find({ key: 'context-7' }))).toEqual(['◇', 'w3', 'useTheme(): Theme gives the stored theme, light or…', 'got w1 w2', 'used by w1'])
    expect(partsOf(await ui.find({ key: 'context-2' }))).toEqual(['✕', 'w2', 'A global stylesheet breaks the old pages, as…', 'got w1'])
    await ui.unmount()
  }
})

test('the shared context shows the metrics of the shared context on every surface', async ($, on) => {
  const state = new FakeState().load(citedRun(), null)
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  for (const surface of ALL_SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(partsOf(await ui.find({ key: 'context-metrics' }))).toEqual([
      '7 entries: 3 facts, 1 fail, 3 interfaces',
      '7 for each done task',
      '6 of 7 delivered, median 0s',
      '1 of 8 received entries cited',
      '1 of 1 fail heeded',
      '0 fails repeated',
    ])
    await ui.unmount()
  }
})

test('a long shared entry is cut to one line', async ($, on) => {
  const state = new FakeState().load(sharedRun(workingRun(3), LONG_SHARE), null)
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const cut = `${'word '.repeat(8).trim()}…`
  expect(await ui.findAll({ type: 'Text', text: cut })).toHaveLength(5)
  expect((await ui.find({ type: 'Text', text: cut }))?.props).toMatchObject({ wrap: 'truncate-end' })
  await ui.unmount()
})

test('a run with no shared entries has no shared context section', async ($, on) => {
  const state = new FakeState().load(workingRun(2), null)
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'sec-context' })).toBeUndefined()
  await ui.unmount()
})

test('a run that meld 0.5.3 stored, with no context, draws the pane with no Shared context section', async ($, on) => {
  const { context: _context, ...stored } = workingRun(2)
  const state = new FakeState().load(stored as Run, null)
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'stop' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Shared context' })).toBeUndefined()
  await ui.unmount()
})

test('the progress section shows a bar and a percent for the whole request on every surface', async ($, on) => {
  const state = new FakeState().load(treeRun(), null)
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  for (const surface of ALL_SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(textsOf(await ui.find({ key: 'progress-all' })).slice(0, 2)).toEqual(['Progress', '33%'])
    await ui.unmount()
  }
})

test('a graphic surface draws the bar of the request and of each row as a picture', async ($, on) => {
  const state = new FakeState().load(treeRun(), null)
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  for (const surface of GRAPHIC_SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const alts = (await ui.findAll({ type: 'Svg' })).map(svg => String(svg.props.alt)).filter(alt => !/^w\d+: /.test(alt))
    expect(alts).toEqual(['The request: 33% done', '#1: 50% done', '#2: 0% done', '#3: 0% done'])
    await ui.unmount()
  }
})

test('the terminal draws the bars in text, with one shape for each part, in the order done, claimed, open', async ($, on) => {
  const state = new FakeState().load(treeRun(), null)
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  expect(partsOf(await ui.find({ key: 'bar-all' }))).toEqual(['█'.repeat(8), '▓'.repeat(14), '░'.repeat(2)])
  expect(partsOf(await ui.find({ key: 'bar-1' }))).toEqual(['█'.repeat(4), '▓'.repeat(4)])
  expect(partsOf(await ui.find({ key: 'bar-3' }))).toEqual(['░'.repeat(8)])
  await ui.unmount()
})

test('each top-level task has one row with its title and its percent, and the parts of a task stay closed', async ($, on) => {
  const state = new FakeState().load(treeRun(), null)
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  for (const surface of ALL_SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(rowKeys(await ui.findAll({ type: 'Box' }))).toEqual(['task-1', 'task-2', 'task-3'])
    expect((await ui.find({ key: 'open-1' }))?.text).toBe('▸ #1 Theme tokens')
    expect(textsOf(await ui.find({ key: 'task-1' })).slice(0, 3)).toEqual(['▸ #1 Theme tokens', '●', '50%'])
    expect(textsOf(await ui.find({ key: 'task-2' })).slice(0, 3)).toEqual(['· #2 Toggle in the header', '●', '0%'])
    await ui.unmount()
  }
})

test('a row shows a dot in the colour of each worker that claims a part of its task', async ($, on) => {
  const state = new FakeState().load(treeRun(), null)
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const dots = (await ui.findAll({ type: 'Text', text: '●' })).map(dot => dot.props.color)
  expect(dots).toContain(agentColor(2).light)
  expect(JSON.stringify(await ui.find({ key: 'task-1' }))).toContain(agentColor(2).light)
  expect(JSON.stringify(await ui.find({ key: 'task-2' }))).toContain(agentColor(1).light)
  expect(JSON.stringify(await ui.find({ key: 'task-3' }))).not.toContain('●')
  await ui.unmount()
})

test('a row says "waits for #N" while a need of its task is not done', async ($, on) => {
  const state = new FakeState().load(treeRun(), null)
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  for (const surface of ALL_SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(textsOf(await ui.find({ key: 'task-3' })).slice(0, 3)).toEqual(['· #3 Docs for the theme', 'waits for #1', '0%'])
    expect(await ui.findAll({ type: 'Text', text: /^waits for/ })).toHaveLength(1)
    await ui.unmount()
  }
})

test('a press on a row opens its children under it, and a second press closes them', async ($, on) => {
  const state = new FakeState().load(treeRun(), null)
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  on('state.set', ($, e) => ({ value: state.set(e) }))
  const first = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await first.press({ key: 'open-1' })
  await first.unmount()
  const second = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(rowKeys(await second.findAll({ type: 'Box' }))).toEqual(['task-1', 'task-4', 'task-5', 'task-2', 'task-3'])
  expect((await second.find({ key: 'open-1' }))?.text).toBe('▾ #1 Theme tokens')
  await second.press({ key: 'open-1' })
  await second.unmount()
  const third = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(rowKeys(await third.findAll({ type: 'Box' }))).toEqual(['task-1', 'task-2', 'task-3'])
  await third.unmount()
})

test('the pane view keeps the open rows in its field open, and its shape stays view-1', async ($, on) => {
  const state = new FakeState().load(treeRun(), null, CLOSED_VIEW)
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  on('state.set', ($, e) => ({ value: state.set(e) }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-1' })
  await ui.unmount()
  expect(state.get('view').value).toEqual({ shape: 'view-1', value: { ...CLOSED_VIEW, open: [1] } })
})

test('a row of a task with no parts has nothing to open', async ($, on) => {
  const state = new FakeState().load(treeRun(), null)
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'open-2' })).toBeUndefined()
  expect(await ui.find({ key: 'open-3' })).toBeUndefined()
  await ui.unmount()
})

test('the progress section holds 100 words at most, with long titles, eight owners and open rows, and counts the rows it leaves out', async ($, on) => {
  const state = new FakeState().load(crowdedRun(), null, { ...CLOSED_VIEW, open: [1] })
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  for (const surface of ALL_SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const block = await ui.find({ key: 'sec-progress' })
    expect(wordsOf(block), surface).toBeLessThanOrEqual(WORD_LIMIT)
    const shown = rowKeys(await ui.findAll({ type: 'Box' })).length
    expect(shown).toBeGreaterThan(1)
    expect((await ui.find({ type: 'Text', text: / more$/ }))?.text).toBe(`${21 - shown} more`)
    await ui.unmount()
  }
})

test('a run that meld 0.6.0 stored, with no task tree and a view with no open rows, draws each task as a top-level row', async ($, on) => {
  const state = new FakeState().load(STORED_BY_0_6_0, null, CLOSED_VIEW)
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  for (const surface of ALL_SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(rowKeys(await ui.findAll({ type: 'Box' }))).toEqual(['task-1', 'task-2', 'task-3'])
    expect(textsOf(await ui.find({ key: 'progress-all' })).slice(0, 2)).toEqual(['Progress', '33%'])
    expect(await ui.find({ type: 'Text', text: /^waits for/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a run that meld 0.7.0 stored draws its task tree, its progress and its shared context, with no block over 100 words', async ($, on) => {
  const state = new FakeState().load(STORED_BY_0_7_0, null, { ...CLOSED_VIEW, open: [1] })
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  for (const surface of ALL_SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(rowKeys(await ui.findAll({ type: 'Box' }))).toEqual(['task-1', 'task-4', 'task-5', 'task-2', 'task-3'])
    expect(textsOf(await ui.find({ key: 'progress-all' })).slice(0, 2)).toEqual(['Progress', '66%'])
    expect(await ui.find({ type: 'Text', text: 'waits for #1' })).toBeDefined()
    const lines = (await ui.findAll({ type: 'Box' })).filter(box => /^context-\d+$/.test(box.key ?? ''))
    expect(lines.map(line => line.key)).toEqual(['context-3', 'context-2'])
    const blocks = (await ui.findAll({ type: 'Box' })).filter(box => box.key?.startsWith('sec-'))
    for (const block of blocks) expect(wordsOf(block), `${block.key} on ${surface}`).toBeLessThanOrEqual(WORD_LIMIT)
    await ui.unmount()
  }
})

test('a split task shows as a parent row, and its parts open under it with their owners', async ($, on) => {
  const state = new FakeState().load(splitRun(), null, { ...CLOSED_VIEW, open: [1] })
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  for (const surface of ALL_SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(rowKeys(await ui.findAll({ type: 'Box' }))).toEqual(['task-1', 'task-5', 'task-6', 'task-2', 'task-3', 'task-4'])
    expect(textsOf(await ui.find({ key: 'task-1' })).slice(0, 3)).toEqual(['▾ #1 Theme tokens in theme.css', '●', '0%'])
    expect(textsOf(await ui.find({ key: 'task-5' })).slice(0, 3)).toEqual(['· #5 Colour tokens', '●', '0%'])
    expect(textsOf(await ui.find({ key: 'task-6' })).slice(0, 2)).toEqual(['· #6 Spacing tokens', '0%'])
    await ui.unmount()
  }
})

test('a parent row is at 100% when the workers finish its parts', async ($, on) => {
  const state = new FakeState().load(splitDoneRun(), null)
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(textsOf(await ui.find({ key: 'task-1' })).slice(0, 2)).toEqual(['▸ #1 Theme tokens in theme.css', '100%'])
  expect(textsOf(await ui.find({ key: 'progress-all' })).slice(0, 2)).toEqual(['Progress', '25%'])
  await ui.unmount()
})
