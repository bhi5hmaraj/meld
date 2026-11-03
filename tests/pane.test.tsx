import { expect, test } from 'claude-code/testing'

import { addCheck, addTasks, bindWorker, claimTask, declareFinal, isFailure, setActivity, startRun, takeIntegration } from '../hooks/board'
import type { Change, Facts, Run, WorkerId } from '../types'

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

type Stored = { value: unknown; version: number }

/** The values of the plugin as the engine stores them: a write with a stale version is refused, as `$.state` does. */
class FakeState {
  values = new Map<string, Stored>()

  load(run: Run | null, facts: Facts | null, view?: object): FakeState {
    this.values.clear()
    if (run) this.values.set('run', { value: { shape: 'run-4', value: run }, version: 1 })
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

function readyRun(): Run {
  return runOf(declareFinal(runOf(takeIntegration(workingRun(3), 'w2', NOW)), 'w2', FULL, 'Adds a dark theme with a toggle, tokens and docs.', NOW))
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
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(4)
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
  expect((await ui.find({ type: 'Text', text: /^Send \/meld/ }))?.text).toBe('Send /meld and the task. Add --agents 3 for three agents.')
  await ui.unmount()
})

test('no block of the pane holds more than 100 words, with eight agents or a ready result', async ($, on) => {
  const state = new FakeState()
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  for (const run of [workingRun(8), readyRun()]) {
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

test('a lane counts the tool calls of a working agent, and shows its tokens once a turn ends', async ($, on) => {
  const run = workingRun(2)
  const counted = { ...run, workers: run.workers.map((worker, index) => ({ ...worker, calls: 27, tokens: index === 1 ? 182_000 : 0 })) }
  const state = new FakeState().load(counted, factsOf(counted))
  on('clock.now', () => ({ value: NOW }))
  on('state.get', ($, e) => ({ value: state.get(e.key) }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '27 calls' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '182k tok' })).toBeDefined()
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
