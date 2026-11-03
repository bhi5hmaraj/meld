import { expect, test } from 'claude-code/testing'

import { startRun } from '../hooks/board'
import { BOARD_TOOLS, TOOL, TOOL_SPECS, workerPrompt, workerRules } from '../hooks/contract'
import type { Run, VcsKind, WorkerId } from '../types'

const IDS: WorkerId[] = ['w1', 'w2', 'w3']

function runOn(vcs: VcsKind, count = 2): Run {
  const ref = (id: WorkerId) => (vcs === 'jj' ? `${id}@` : `meld/r1/${id}`)
  const workers = IDS.slice(0, count).map(id => ({ id, path: `/tmp/meld/r1/${id}`, ref: ref(id), agent: { type: 'meld:worker' } }))
  return startRun({ id: 'r1', request: 'Add a dark theme', repo: '/repo', base: 'abc1234def', vcs, now: 0, workers })
}

test('the rules of a git run name the branches of the other workers and git merge', () => {
  const rules = workerRules(runOn('git'), 'w1')
  expect(rules).toContain('You are w1')
  expect(rules).toContain('meld/r1/w2')
  expect(rules).toContain('git merge')
})

test('the rules of a jj run use jj commit and the last commits of the other workers', () => {
  const rules = workerRules(runOn('jj'), 'w1')
  expect(rules).toContain('jj commit -m')
  expect(rules).toContain('w2@-')
  expect(rules).not.toContain('git merge')
})

test('the rules name every other worker', () => {
  const rules = workerRules(runOn('git', 3), 'w2')
  expect(rules).toContain('w1 (meld/r1/w1)')
  expect(rules).toContain('w3 (meld/r1/w3)')
})

test('the spawn prompt holds the request and sends the worker to the board first', () => {
  const prompt = workerPrompt(runOn('git'), 'w2')
  expect(prompt).toContain('Add a dark theme')
  expect(prompt).toContain(TOOL.board)
  expect(prompt).toContain('w2')
})

test('each meld tool has a spec', () => {
  expect(TOOL_SPECS.map(spec => `mcp__meld__${spec.name}`).sort()).toEqual(Object.values(TOOL).sort())
})

test('the board hook serves each tool of a worker, and no tool of the main session', () => {
  const session = new Set<string>([TOOL.start, TOOL.steer, TOOL.stop])
  expect([...BOARD_TOOLS].sort()).toEqual(Object.values(TOOL).filter(tool => !session.has(tool)).sort())
})

test('the share tool takes a kind of fact, fail or interface, and a text of 500 characters at most', () => {
  const share = TOOL_SPECS.find(spec => spec.name === 'share')
  expect(share?.inputSchema).toMatchObject({
    properties: { kind: { enum: ['fact', 'fail', 'interface'] }, text: { maxLength: 500 }, files: { type: 'array' }, replaces: { type: 'number' } },
    required: ['kind', 'text'],
  })
})

test('finish_task takes interfaces and unfinished text, and needs neither', () => {
  const finish = TOOL_SPECS.find(spec => spec.name === 'finish_task')
  expect(finish?.inputSchema).toMatchObject({ properties: { interfaces: { type: 'string' }, unfinished: { type: 'string' } }, required: ['task', 'version', 'commit', 'summary'] })
})

test('the rules say when to share a fact, a fail and an interface', () => {
  const rules = workerRules(runOn('jj'), 'w1')
  expect(rules).toContain(`Share with ${TOOL.share}: a fact when a peer can use it, a fail when an approach did not work, and an interface before a peer depends on it.`)
})

test('the rules tell a worker to read the shared context before it starts a task', () => {
  expect(workerRules(runOn('git'), 'w2')).toContain('Read it before you start a task')
})

test('the rules send the contracts and the work left of a task to finish_task', () => {
  const rules = workerRules(runOn('git'), 'w1')
  expect(rules).toContain(`call ${TOOL.finishTask} with the commit and a one-line summary`)
  expect(rules).toContain('Give the contracts that other tasks use in interfaces, and the work that you did not do in unfinished.')
})

test('the note tool sends a fact, a fail and an interface to share', () => {
  const note = TOOL_SPECS.find(spec => spec.name === 'note')
  expect(note?.description).toContain('For a fact, a fail or an interface, use share.')
  expect(note?.description).not.toContain('need: an interface')
})
